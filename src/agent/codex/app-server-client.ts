import type { Readable, Writable } from 'node:stream';
import type { SpawnedProcessByStdio } from '../../platform/spawn';
import { mergeProcessEnv, spawnProcess } from '../../platform/spawn';
import { log } from '../../core/logger';

type AppServerChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

export interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

export interface AppServerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  expected: boolean;
  stderr: string;
}

export interface CodexAppServerClientOptions {
  binary: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
  initializeTimeoutMs?: number;
  shutdownGraceMs?: number;
  clientVersion?: string;
  spawn?: (binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => AppServerChild;
}

export interface CodexAppServerTransport {
  ensureStarted(): Promise<void>;
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  notify(method: string, params?: unknown): Promise<void>;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  onExit(listener: (exit: AppServerExit) => void): () => void;
  pid(): number | undefined;
  close(): Promise<void>;
}

interface PendingRequest {
  method: string;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const MAX_STDERR_CHARS = 4_096;

export class CodexAppServerRpcError extends Error {
  readonly code: number | string | undefined;

  constructor(method: string, input: unknown) {
    const error = recordValue(input);
    const message = typeof error?.message === 'string' ? error.message : 'unknown JSON-RPC error';
    super(`codex app-server rejected ${method}: ${message}`);
    this.name = 'CodexAppServerRpcError';
    this.code =
      typeof error?.code === 'number' || typeof error?.code === 'string'
        ? error.code
        : undefined;
  }
}

export class CodexAppServerClient implements CodexAppServerTransport {
  private readonly options: Required<
    Pick<
      CodexAppServerClientOptions,
      'requestTimeoutMs' | 'initializeTimeoutMs' | 'shutdownGraceMs' | 'clientVersion'
    >
  > &
    CodexAppServerClientOptions;
  private child: AppServerChild | undefined;
  private startPromise: Promise<void> | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly exitListeners = new Set<(exit: AppServerExit) => void>();
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private ready = false;
  private closing = false;
  private closed = false;

  constructor(options: CodexAppServerClientOptions) {
    this.options = {
      ...options,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      initializeTimeoutMs: options.initializeTimeoutMs ?? DEFAULT_INITIALIZE_TIMEOUT_MS,
      shutdownGraceMs: options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
      clientVersion: options.clientVersion ?? '0.3.0',
    };
  }

  pid(): number | undefined {
    return this.child?.pid;
  }

  async ensureStarted(): Promise<void> {
    if (this.closed) throw new Error('codex app-server client is closed');
    if (this.ready && this.child) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start().finally(() => {
      this.startPromise = undefined;
    });
    return this.startPromise;
  }

  async request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    await this.ensureStarted();
    return this.rawRequest<T>(method, params, timeoutMs ?? this.options.requestTimeoutMs);
  }

  async notify(method: string, params?: unknown): Promise<void> {
    await this.ensureStarted();
    this.writeMessage(params === undefined ? { method } : { method, params });
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onExit(listener: (exit: AppServerExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      this.ready = false;
      this.child = undefined;
      return;
    }

    child.stdin.end();
    const exited = await waitForExit(child, this.options.shutdownGraceMs);
    if (!exited && child.exitCode === null && child.signalCode === null) {
      log.warn('app-server', 'shutdown-timeout', {
        pid: child.pid ?? null,
        graceMs: this.options.shutdownGraceMs,
      });
      child.kill('SIGTERM');
      const terminated = await waitForExit(child, this.options.shutdownGraceMs);
      if (!terminated && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await waitForExit(child, 1_000);
      }
    }
  }

  private async start(): Promise<void> {
    this.ready = false;
    this.closing = false;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';

    const env = mergeProcessEnv(process.env, this.options.env);
    const args = [
      'app-server',
      '--listen',
      'stdio://',
      '-c',
      'approval_policy="never"',
      '-c',
      'shell_environment_policy.inherit="all"',
    ];
    const child = this.options.spawn
      ? this.options.spawn(this.options.binary, args, env)
      : (spawnProcess(this.options.binary, args, {
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
        }) as AppServerChild);
    this.child = child;
    this.attachChild(child);

    if (!child.pid) {
      const error = new Error('failed to spawn codex app-server: spawn returned no pid');
      this.rejectAll(error);
      throw error;
    }
    log.info('app-server', 'spawn', { pid: child.pid });

    try {
      await this.rawRequest(
        'initialize',
        {
          clientInfo: {
            name: 'lark-channel-bridge',
            title: 'Lark Channel Bridge',
            version: this.options.clientVersion,
          },
          capabilities: null,
        },
        this.options.initializeTimeoutMs,
      );
      this.writeMessage({ method: 'initialized' });
      this.ready = true;
      log.info('app-server', 'initialized', { pid: child.pid });
    } catch (error) {
      this.ready = false;
      this.closing = true;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      throw new Error(
        `codex app-server initialization failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
  }

  private attachChild(child: AppServerChild): void {
    child.stdout.on('data', (chunk: Buffer | string) => this.consumeStdout(chunk));
    child.stdout.on('end', () => this.consumeTrailingStdout());
    child.stderr.on('data', (chunk: Buffer | string) => this.consumeStderr(chunk));
    child.stdin.on('error', (error) => {
      if (!this.closing) log.warn('app-server', 'stdin-error', { message: error.message });
    });
    child.once('error', (error) => {
      this.handleExit(child, null, null, error);
    });
    child.once('exit', (code, signal) => {
      this.handleExit(child, code, signal);
    });
  }

  private rawRequest<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      return Promise.reject(new Error(`codex app-server is not running for ${method}`));
    }
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server request timed out: ${method} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.writeMessage(params === undefined ? { method, id } : { method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private writeMessage(message: object): void {
    const child = this.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      throw new Error('codex app-server is not running');
    }
    child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8');
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString();
    let newline = this.stdoutBuffer.indexOf('\n');
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.consumeLine(line);
      newline = this.stdoutBuffer.indexOf('\n');
    }
  }

  private consumeTrailingStdout(): void {
    const line = this.stdoutBuffer.trim();
    this.stdoutBuffer = '';
    if (line) this.consumeLine(line);
  }

  private consumeLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let input: unknown;
    try {
      input = JSON.parse(trimmed);
    } catch {
      log.warn('app-server', 'non-json-stdout', { chars: trimmed.length });
      return;
    }
    const message = recordValue(input);
    if (!message) {
      log.warn('app-server', 'malformed-message', { kind: typeof input });
      return;
    }

    if (typeof message.id === 'number' && ('result' in message || 'error' in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        log.warn('app-server', 'orphan-response', { requestId: message.id });
        return;
      }
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error !== undefined && message.error !== null) {
        pending.reject(new CodexAppServerRpcError(pending.method, message.error));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (typeof message.method === 'string' && message.id === undefined) {
      const notification: JsonRpcNotification = {
        method: message.method,
        ...(message.params !== undefined ? { params: message.params } : {}),
      };
      for (const listener of [...this.notificationListeners]) {
        try {
          listener(notification);
        } catch (error) {
          log.warn('app-server', 'notification-listener-failed', {
            method: notification.method,
            message: errorMessage(error),
          });
        }
      }
      return;
    }

    log.warn('app-server', 'unknown-message-shape', { keys: Object.keys(message).slice(0, 8) });
  }

  private consumeStderr(chunk: Buffer | string): void {
    this.stderrBuffer = `${this.stderrBuffer}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
    const lines = chunk
      .toString()
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      log.warn('app-server', 'stderr', { stderr: line.slice(0, 500) });
    }
  }

  private handleExit(
    child: AppServerChild,
    code: number | null,
    signal: NodeJS.Signals | null,
    spawnError?: Error,
  ): void {
    if (this.child !== child) return;
    const expected = this.closing || this.closed;
    this.child = undefined;
    this.ready = false;
    const detail = spawnError ? `: ${spawnError.message}` : '';
    const error = new Error(
      `codex app-server exited${code !== null ? ` with code ${code}` : signal ? ` by ${signal}` : ''}${detail}`,
    );
    this.rejectAll(error);
    const exit: AppServerExit = {
      code,
      signal,
      expected,
      stderr: this.stderrBuffer,
    };
    log[expected ? 'info' : 'warn']('app-server', 'exit', {
      pid: child.pid ?? null,
      code,
      signal,
      expected,
      stderr: this.stderrBuffer,
    });
    for (const listener of [...this.exitListeners]) listener(exit);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForExit(child: AppServerChild, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    child.once('exit', onExit);
  });
}
