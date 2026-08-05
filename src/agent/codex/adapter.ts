import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { lstat, mkdir, readdir, symlink } from 'node:fs/promises';
import type { SandboxMode } from '../../config/profile-schema';
import { log } from '../../core/logger';
import { mergeProcessEnv } from '../../platform/spawn';
import { SpawnFailed } from '../../runtime/errors';
import {
  listCodexThreadHistory,
  type CodexThreadHistoryEntry,
} from '../../session/codex-history';
import { buildBridgeSystemPrompt } from '../bridge-system-prompt';
import { buildLarkChannelEnv, type LarkChannelEnvContext } from '../lark-channel-env';
import { checkAgentAvailability, type AgentAvailability } from '../preflight';
import type {
  AgentAdapter,
  AgentBotIdentity,
  AgentEvent,
  AgentModelOption,
  AgentRun,
  AgentRunOptions,
} from '../types';
import {
  CodexAppServerClient,
  CodexAppServerRpcError,
  type AppServerExit,
  type CodexAppServerTransport,
  type JsonRpcNotification,
} from './app-server-client';

export interface CodexAdapterOptions {
  binary: string;
  profileStateDir: string;
  codexHome?: string;
  inheritCodexHome?: boolean;
  ignoreUserConfig?: boolean;
  ignoreRules?: boolean;
  sandbox?: SandboxMode;
  stopGraceMs?: number;
  larkChannel?: LarkChannelEnvContext;
  client?: CodexAppServerTransport;
}

interface ThreadResponse {
  thread?: { id?: unknown; turns?: unknown };
  model?: unknown;
  cwd?: unknown;
}

interface TurnResponse {
  turn?: { id?: unknown };
}

interface TurnSteerResponse {
  turnId?: unknown;
}

interface ModelListResponse {
  data?: unknown;
  nextCursor?: unknown;
}

interface TurnRuntime {
  threadId?: string;
  turnId?: string;
  turnStartedObserved: boolean;
  terminal: boolean;
  stopRequested: boolean;
  lastError?: string;
  bufferedNotifications: JsonRpcNotification[];
  textDeltaItems: Set<string>;
  startedTools: Set<string>;
  toolOutput: Map<string, string>;
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'Codex App Server';

  private readonly binary: string;
  private readonly profileStateDir: string;
  private readonly codexHome: string | undefined;
  private readonly inheritCodexHome: boolean;
  private readonly ignoreUserConfig: boolean;
  private readonly ignoreRules: boolean;
  private readonly sourceCodexHome: string;
  private readonly effectiveCodexHome: string | undefined;
  private readonly sandbox: SandboxMode;
  private readonly defaultStopGraceMs: number;
  private readonly larkChannel: LarkChannelEnvContext | undefined;
  private readonly client: CodexAppServerTransport;
  private botIdentity: AgentBotIdentity | undefined;

  constructor(opts: CodexAdapterOptions) {
    this.binary = opts.binary;
    this.profileStateDir = opts.profileStateDir;
    this.codexHome = opts.codexHome;
    this.inheritCodexHome = opts.inheritCodexHome !== false;
    this.ignoreUserConfig = opts.ignoreUserConfig === true;
    this.ignoreRules = opts.ignoreRules !== false;
    this.sourceCodexHome =
      opts.codexHome ??
      (this.inheritCodexHome
        ? process.env.CODEX_HOME ?? join(homedir(), '.codex')
        : join(this.profileStateDir, 'codex-home'));
    this.effectiveCodexHome =
      this.ignoreUserConfig || this.ignoreRules
        ? join(
            this.profileStateDir,
            `codex-home-app-server-${this.ignoreUserConfig ? 'no-config' : 'config'}-${this.ignoreRules ? 'no-rules' : 'rules'}`,
          )
        : this.codexHome ?? (this.inheritCodexHome ? undefined : join(this.profileStateDir, 'codex-home'));
    this.sandbox = opts.sandbox ?? 'danger-full-access';
    this.defaultStopGraceMs = opts.stopGraceMs ?? 5_000;
    this.larkChannel = opts.larkChannel;
    this.client = opts.client ?? new CodexAppServerClient({
      binary: this.binary,
      env: this.appServerEnv(),
    });
  }

  setBotIdentity(identity: AgentBotIdentity): void {
    this.botIdentity = identity;
  }

  appServerPid(): number | undefined {
    return this.client.pid();
  }

  async isAvailable(): Promise<boolean> {
    return (await this.checkAvailability()).ok;
  }

  async checkAvailability(): Promise<AgentAvailability> {
    return checkAgentAvailability({
      agentId: 'codex',
      agentName: 'Codex App Server',
      command: this.binary,
      binaryPath: this.binary,
    });
  }

  async prepareRun(): Promise<void> {
    const availability = await this.checkAvailability();
    if (!availability.ok) {
      throw new SpawnFailed(
        'codex binary check failed',
        availability.error,
        availability.diagnostic.code,
        availability.diagnostic,
      );
    }
    try {
      await this.prepareCompatibilityHome();
      await this.client.ensureStarted();
    } catch (error) {
      throw new SpawnFailed(
        'codex app-server preflight failed',
        error,
        'codex-app-server-unavailable',
        {
          code: 'codex-app-server-unavailable',
          agentId: 'codex',
          agentName: 'Codex App Server',
          command: this.binary,
          binaryPath: this.binary,
          details: errorMessage(error),
          recovery: '升级 Codex CLI，并确认 `codex app-server --listen stdio://` 可用。',
        },
      );
    }
  }

  run(opts: AgentRunOptions): AgentRun {
    if (!opts.cwd) throw new Error('cwd is required for CodexAdapter.run');

    const queue = new AsyncEventQueue<AgentEvent>();
    const runtime: TurnRuntime = {
      turnStartedObserved: false,
      terminal: false,
      stopRequested: false,
      bufferedNotifications: [],
      textDeltaItems: new Set(),
      startedTools: new Set(),
      toolOutput: new Map(),
    };
    let settled = false;
    let settleExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      settleExit = resolve;
    });
    const terminal = (event: AgentEvent): void => {
      if (runtime.terminal) return;
      runtime.terminal = true;
      queue.push(event);
      queue.close();
      if (!settled) {
        settled = true;
        settleExit();
      }
    };

    const unsubscribeNotification = this.client.onNotification((notification) => {
      if (!runtime.threadId || !runtime.turnId) {
        runtime.bufferedNotifications.push(notification);
        return;
      }
      this.translateNotification(notification, runtime, queue, terminal);
    });
    const unsubscribeExit = this.client.onExit((exit) => {
      if (!exit.expected && !runtime.terminal) terminal(appServerExitError(exit));
    });

    const start = async (): Promise<void> => {
      try {
        await this.client.ensureStarted();
        const sandbox = opts.sandbox ?? this.sandbox;
        const commonThreadParams = {
          cwd: opts.cwd!,
          approvalPolicy: 'never',
          sandbox,
          ...(opts.model ? { model: opts.model } : {}),
          developerInstructions: buildBridgeSystemPrompt(this.botIdentity),
        };
        const thread = opts.threadId
          ? await this.client.request<ThreadResponse>('thread/resume', {
              threadId: opts.threadId,
              ...commonThreadParams,
            })
          : await this.client.request<ThreadResponse>('thread/start', commonThreadParams);
        const threadId = stringValue(thread.thread?.id);
        if (!threadId) throw new Error('codex app-server returned no thread id');
        runtime.threadId = threadId;
        queue.push({
          type: 'system',
          threadId,
          cwd: stringValue(thread.cwd) ?? opts.cwd,
          ...(stringValue(thread.model) ? { model: stringValue(thread.model) } : {}),
        });

        const input = [
          { type: 'text', text: opts.prompt, text_elements: [] },
          ...(opts.images ?? []).map((path) => ({ type: 'localImage', path })),
        ];
        let turnId: string | undefined;
        const activeTurnId = opts.threadId
          ? inProgressTurnId(thread.thread)
          : undefined;
        if (activeTurnId) {
          try {
            const steered = await this.client.request<TurnSteerResponse>('turn/steer', {
              threadId,
              expectedTurnId: activeTurnId,
              input,
            });
            turnId = stringValue(steered.turnId) ?? activeTurnId;
            log.info('app-server', 'turn-steered', { turnId: turnId.slice(-8) });
          } catch (error) {
            // The active turn can finish between thread/resume and turn/steer.
            // A rejected precondition means the prompt was not accepted, so it
            // is safe to fall through and start a fresh turn instead.
            if (!(error instanceof CodexAppServerRpcError)) throw error;
            log.info('app-server', 'turn-steer-raced', { turnId: activeTurnId.slice(-8) });
          }
        }
        if (!turnId) {
          const turn = await this.client.request<TurnResponse>('turn/start', {
            threadId,
            input,
            cwd: opts.cwd,
            approvalPolicy: 'never',
            sandboxPolicy: sandboxPolicy(sandbox, opts.cwd!),
            ...(opts.model ? { model: opts.model } : {}),
            ...(opts.reasoningEffort ? { effort: opts.reasoningEffort } : {}),
          });
          turnId = stringValue(turn.turn?.id);
        }
        if (!turnId) throw new Error('codex app-server returned no turn id');
        runtime.turnId = turnId;

        // A resumed thread can report a different active turn id in the
        // authoritative turn/started notification than in the turn/start
        // response (notably after the previous turn was interrupted). Reconcile
        // that buffered notification before exposing the accepted turn id or
        // filtering any following deltas, otherwise the entire live stream is
        // silently discarded as belonging to another turn.
        const buffered = runtime.bufferedNotifications.splice(0);
        for (const notification of buffered) {
          this.reconcileTurnStarted(notification, runtime);
        }
        const acceptedTurnId = runtime.turnId;
        queue.push({ type: 'system', threadId, turnId: acceptedTurnId, cwd: opts.cwd });

        try {
          await opts.onTurnAccepted?.({ threadId, turnId: acceptedTurnId });
        } catch (error) {
          log.warn('context', 'cursor-commit-failed', { message: errorMessage(error) });
        }

        for (const notification of buffered) {
          this.translateNotification(notification, runtime, queue, terminal);
        }
        if (runtime.stopRequested && !runtime.terminal) {
          await this.interrupt(runtime);
        }
      } catch (error) {
        terminal({
          type: 'error',
          message: errorMessage(error),
          terminationReason: runtime.stopRequested ? 'interrupted' : 'failed',
        });
      }
    };
    void start();

    const cleanup = (): void => {
      unsubscribeNotification();
      unsubscribeExit();
    };
    void exited.then(cleanup);

    return {
      runId: opts.runId,
      events: queue,
      stop: async () => {
        runtime.stopRequested = true;
        if (runtime.threadId && runtime.turnId && !runtime.terminal) {
          await this.interrupt(runtime);
        }
      },
      async waitForExit(timeoutMs: number): Promise<boolean> {
        if (settled) return true;
        return Promise.race([
          exited.then(() => true),
          new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
        ]);
      },
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async listThreadHistory(input: {
    cwd: string;
    limit: number;
    timeoutMs?: number;
  }): Promise<CodexThreadHistoryEntry[]> {
    await this.prepareCompatibilityHome();
    return listCodexThreadHistory(input, this.client);
  }

  async listModels(): Promise<AgentModelOption[]> {
    const models: AgentModelOption[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 20; page++) {
      const response = await this.client.request<ModelListResponse>('model/list', {
        includeHidden: false,
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      const data = Array.isArray(response.data) ? response.data : [];
      for (const item of data) {
        const model = parseModelOption(item);
        if (!model || seen.has(model.value)) continue;
        seen.add(model.value);
        models.push(model);
      }
      cursor = stringValue(response.nextCursor);
      if (!cursor) break;
    }
    if (models.length === 0) throw new Error('codex app-server returned no available models');
    return models;
  }

  private async interrupt(runtime: TurnRuntime): Promise<void> {
    if (!runtime.threadId || !runtime.turnId || runtime.terminal) return;
    try {
      await this.client.request(
        'turn/interrupt',
        { threadId: runtime.threadId, turnId: runtime.turnId },
        this.defaultStopGraceMs,
      );
    } catch (error) {
      if (!runtime.terminal) throw error;
    }
  }

  private translateNotification(
    notification: JsonRpcNotification,
    runtime: TurnRuntime,
    queue: AsyncEventQueue<AgentEvent>,
    terminal: (event: AgentEvent) => void,
  ): void {
    if (runtime.terminal) return;
    if (this.reconcileTurnStarted(notification, runtime)) return;
    const params = recordValue(notification.params);
    if (!params || params.threadId !== runtime.threadId) return;
    const notificationTurnId = stringValue(params.turnId) ?? stringValue(recordValue(params.turn)?.id);
    if (notificationTurnId && notificationTurnId !== runtime.turnId) return;

    switch (notification.method) {
      case 'item/agentMessage/delta': {
        const itemId = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        if (itemId && delta) {
          runtime.textDeltaItems.add(itemId);
          queue.push({ type: 'text', delta });
        }
        return;
      }
      case 'item/reasoning/summaryTextDelta':
      case 'item/reasoning/textDelta': {
        const delta = stringValue(params.delta);
        if (delta) queue.push({ type: 'thinking', delta });
        return;
      }
      case 'item/commandExecution/outputDelta':
      case 'item/fileChange/outputDelta': {
        const itemId = stringValue(params.itemId);
        const delta = stringValue(params.delta);
        if (itemId && delta) {
          runtime.toolOutput.set(itemId, `${runtime.toolOutput.get(itemId) ?? ''}${delta}`);
        }
        return;
      }
      case 'item/started': {
        const item = recordValue(params.item);
        const mapped = item ? toolStartEvent(item) : undefined;
        if (mapped) {
          runtime.startedTools.add(mapped.id);
          queue.push(mapped);
        }
        return;
      }
      case 'item/completed': {
        const item = recordValue(params.item);
        if (!item) return;
        const itemId = stringValue(item.id);
        if (item.type === 'agentMessage') {
          const text = stringValue(item.text);
          if (text) queue.push({ type: 'final_text', content: text });
          return;
        }
        const mapped = toolResultEvent(item, runtime.toolOutput.get(itemId ?? ''));
        if (mapped) queue.push(mapped);
        return;
      }
      case 'thread/tokenUsage/updated': {
        const last = recordValue(recordValue(params.tokenUsage)?.last);
        if (last) {
          queue.push({
            type: 'usage',
            inputTokens: numberValue(last.inputTokens),
            outputTokens: numberValue(last.outputTokens),
            cachedInputTokens: numberValue(last.cachedInputTokens),
            reasoningOutputTokens: numberValue(last.reasoningOutputTokens),
          });
        }
        return;
      }
      case 'error': {
        const error = recordValue(params.error);
        runtime.lastError = stringValue(error?.message) ?? 'codex app-server error';
        log.warn('app-server', 'turn-error-notification', {
          willRetry: params.willRetry === true,
          message: runtime.lastError,
        });
        return;
      }
      case 'turn/completed': {
        const turn = recordValue(params.turn);
        const status = stringValue(turn?.status);
        if (status === 'completed') {
          terminal({ type: 'done', threadId: runtime.threadId, terminationReason: 'normal' });
        } else if (status === 'interrupted') {
          terminal({ type: 'done', threadId: runtime.threadId, terminationReason: 'interrupted' });
        } else {
          const turnError = recordValue(turn?.error);
          terminal({
            type: 'error',
            message:
              stringValue(turnError?.message) ?? runtime.lastError ?? 'codex turn failed',
            terminationReason: 'failed',
          });
        }
        return;
      }
      default:
        if (isTurnNotification(notification.method)) {
          log.warn('app-server', 'unknown-turn-notification', { method: notification.method });
        }
    }
  }

  private reconcileTurnStarted(notification: JsonRpcNotification, runtime: TurnRuntime): boolean {
    if (notification.method !== 'turn/started') return false;
    const params = recordValue(notification.params);
    if (!params || params.threadId !== runtime.threadId) return true;
    const startedTurnId =
      stringValue(recordValue(params.turn)?.id) ?? stringValue(params.turnId);
    if (!startedTurnId || runtime.turnStartedObserved) return true;
    runtime.turnStartedObserved = true;
    if (runtime.turnId && runtime.turnId !== startedTurnId) {
      log.warn('app-server', 'turn-id-reconciled', {
        expected: runtime.turnId.slice(-8),
        actual: startedTurnId.slice(-8),
      });
    }
    runtime.turnId = startedTurnId;
    return true;
  }

  private appServerEnv(): NodeJS.ProcessEnv {
    const overrides: NodeJS.ProcessEnv = buildLarkChannelEnv(this.larkChannel);
    if (this.effectiveCodexHome) overrides.CODEX_HOME = this.effectiveCodexHome;
    return mergeProcessEnv(process.env, overrides);
  }

  /**
   * App Server has no `--ignore-user-config` / `--ignore-rules` flags. Build a
   * private CODEX_HOME view that shares durable auth/session state with the
   * configured home while omitting only the requested config/rules entries.
   * Symlinks keep desktop deep links and thread history on the same store.
   */
  private async prepareCompatibilityHome(): Promise<void> {
    if (!this.effectiveCodexHome || (!this.ignoreUserConfig && !this.ignoreRules)) return;
    await mkdir(this.effectiveCodexHome, { recursive: true, mode: 0o700 });
    let entries;
    try {
      entries = await readdir(this.sourceCodexHome, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (shouldOmitCompatibilityEntry(entry.name, this.ignoreUserConfig, this.ignoreRules)) {
        continue;
      }
      const source = join(this.sourceCodexHome, entry.name);
      const target = join(this.effectiveCodexHome, entry.name);
      try {
        await lstat(target);
        continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      try {
        await symlink(source, target, entry.isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw new Error(
            `failed to prepare Codex App Server compatibility home entry ${basename(source)}: ${errorMessage(error)}`,
            { cause: error },
          );
        }
      }
    }
  }
}

function parseModelOption(input: unknown): AgentModelOption | undefined {
  const model = recordValue(input);
  const value = stringValue(model?.model) ?? stringValue(model?.id);
  if (!model || !value || model.hidden === true) return undefined;
  const supportedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts.flatMap((input) => {
        const effort = recordValue(input);
        const effortValue = stringValue(effort?.reasoningEffort);
        return effortValue
          ? [{ value: effortValue, description: stringValue(effort?.description) ?? '' }]
          : [];
      })
    : [];
  return {
    value,
    label: stringValue(model.displayName) ?? value,
    description: stringValue(model.description) ?? '',
    isDefault: model.isDefault === true,
    ...(stringValue(model.defaultReasoningEffort)
      ? { defaultReasoningEffort: stringValue(model.defaultReasoningEffort) }
      : {}),
    supportedReasoningEfforts,
  };
}

const VOLATILE_CODEX_HOME_ENTRIES = new Set([
  'app-server-control',
  'app-server-daemon',
  'ipc',
  'log',
  'shell_snapshots',
  'tmp',
]);

function shouldOmitCompatibilityEntry(
  name: string,
  ignoreUserConfig: boolean,
  ignoreRules: boolean,
): boolean {
  if (VOLATILE_CODEX_HOME_ENTRIES.has(name)) return true;
  if (ignoreRules && name === 'rules') return true;
  return ignoreUserConfig && (name === 'config.toml' || name.startsWith('config.toml.'));
}

function sandboxPolicy(mode: SandboxMode, cwd: string): Record<string, unknown> {
  if (mode === 'danger-full-access') return { type: 'dangerFullAccess' };
  if (mode === 'read-only') return { type: 'readOnly', networkAccess: false };
  return {
    type: 'workspaceWrite',
    writableRoots: [cwd],
    networkAccess: true,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
}

function toolStartEvent(
  item: Record<string, unknown>,
): Extract<AgentEvent, { type: 'tool_use' }> | undefined {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (!id || !type || type === 'agentMessage' || type === 'reasoning' || type === 'userMessage') {
    return undefined;
  }
  if (type === 'commandExecution') {
    return {
      type: 'tool_use',
      id,
      name: 'command_execution',
      input: { command: stringValue(item.command) ?? '' },
    };
  }
  if (type === 'fileChange') {
    return { type: 'tool_use', id, name: 'file_change', input: item.changes ?? [] };
  }
  if (type === 'mcpToolCall') {
    return {
      type: 'tool_use',
      id,
      name: `${stringValue(item.server) ?? 'mcp'}.${stringValue(item.tool) ?? 'tool'}`,
      input: item.arguments,
    };
  }
  return { type: 'tool_use', id, name: camelToSnake(type), input: item };
}

function toolResultEvent(
  item: Record<string, unknown>,
  streamedOutput: string | undefined,
): Extract<AgentEvent, { type: 'tool_result' }> | undefined {
  const id = stringValue(item.id);
  const type = stringValue(item.type);
  if (!id || !type || type === 'agentMessage' || type === 'reasoning' || type === 'userMessage') {
    return undefined;
  }
  const status = stringValue(item.status);
  const isError = status === 'failed' || status === 'declined';
  let output = streamedOutput ?? '';
  if (!output && type === 'commandExecution') output = stringValue(item.aggregatedOutput) ?? '';
  if (!output && type === 'fileChange') output = stringify(item.changes ?? []);
  if (!output && type === 'mcpToolCall') output = stringify(item.result ?? item.error ?? '');
  if (!output) output = stringify(item);
  return { type: 'tool_result', id, output, isError };
}

function appServerExitError(exit: AppServerExit): AgentEvent {
  return {
    type: 'error',
    message: `codex app-server exited unexpectedly${exit.code !== null ? ` with code ${exit.code}` : exit.signal ? ` by ${exit.signal}` : ''}`,
    terminationReason: 'failed',
  };
}

function isTurnNotification(method: string): boolean {
  return method === 'error' || method.startsWith('turn/') || method.startsWith('item/');
}

function inProgressTurnId(input: unknown): string | undefined {
  const turns = recordValue(input)?.turns;
  if (!Array.isArray(turns)) return undefined;
  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = recordValue(turns[index]);
    if (turn?.status !== 'inProgress') continue;
    const id = stringValue(turn.id);
    if (id) return id;
  }
  return undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' && input.length > 0 ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function stringify(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input) ?? '';
  } catch {
    return String(input);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function camelToSnake(value: string): string {
  return value.replace(/[A-Z]/g, (match) => `_${match.toLowerCase()}`);
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private ended = false;

  push(value: T): void {
    if (this.ended) return;
    this.values.push(value);
    this.wake();
  }

  close(): void {
    this.ended = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      const value = this.values.shift();
      if (value !== undefined) {
        yield value;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private wake(): void {
    for (const waiter of this.waiters.splice(0)) waiter();
  }
}
