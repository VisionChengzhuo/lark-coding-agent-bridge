import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.hoisted(() => ({
  spawnProcess: vi.fn(),
}));

vi.mock('../../../src/platform/spawn', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/platform/spawn')>();
  return { ...actual, spawnProcess: spawnMock.spawnProcess };
});

import {
  buildBridgeSystemPrompt,
} from '../../../src/agent/bridge-system-prompt';
import { ClaudeAdapter } from '../../../src/agent/claude/adapter';
import { CodexAdapter } from '../../../src/agent/codex/adapter';
import type {
  AppServerExit,
  CodexAppServerTransport,
  JsonRpcNotification,
} from '../../../src/agent/codex/app-server-client';

interface FakeChild extends EventEmitter {
  pid: number;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = 0;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  spawnMock.spawnProcess.mockReset();
});

describe('ClaudeAdapter system prompt wiring', () => {
  it('appends the identity-aware bridge system prompt via a temp file after setBotIdentity', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    // The prompt goes via stdin, never argv (cmd.exe would mangle it on Windows).
    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
  });

  it('falls back to the base system prompt when no identity was set', async () => {
    const child = fakeChild();
    spawnMock.spawnProcess.mockReturnValue(child);
    const adapter = new ClaudeAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });

    expect(await readAll(child.stdin)).toBe('hi');
    expect(systemPromptFileContent()).toBe(buildBridgeSystemPrompt(undefined));
  });

  function systemPromptFileContent(): string {
    const args = spawnMock.spawnProcess.mock.calls[0]?.[1] as string[];
    const flagIndex = args.indexOf('--append-system-prompt-file');
    expect(flagIndex).toBeGreaterThan(-1);
    expect(args).not.toContain('--append-system-prompt');
    return readFileSync(args[flagIndex + 1] as string, 'utf8');
  }
});

describe('CodexAdapter system prompt wiring', () => {
  class CapturingTransport implements CodexAppServerTransport {
    requests: Array<{ method: string; params: Record<string, unknown> }> = [];
    notifications = new Set<(value: JsonRpcNotification) => void>();
    exits = new Set<(value: AppServerExit) => void>();
    async ensureStarted() {}
    async request<T>(method: string, raw?: unknown): Promise<T> {
      const params = (raw ?? {}) as Record<string, unknown>;
      this.requests.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-1' }, cwd: '/tmp' } as T;
      if (method === 'turn/start') return { turn: { id: 'turn-1' } } as T;
      return {} as T;
    }
    async notify() {}
    onNotification(listener: (value: JsonRpcNotification) => void) {
      this.notifications.add(listener);
      return () => this.notifications.delete(listener);
    }
    onExit(listener: (value: AppServerExit) => void) {
      this.exits.add(listener);
      return () => this.exits.delete(listener);
    }
    pid() { return 4242; }
    async close() {}
  }

  function codexAdapter(): { adapter: CodexAdapter; transport: CapturingTransport } {
    const transport = new CapturingTransport();
    const adapter = new CodexAdapter({
      binary: '/usr/local/bin/codex',
      profileStateDir: '/tmp/codex-profile',
      client: transport,
    });
    return { adapter, transport };
  }

  it('passes the identity-aware bridge prompt as thread developer instructions', async () => {
    const { adapter, transport } = codexAdapter();
    adapter.setBotIdentity({ openId: 'ou_bot_self', name: 'Bridge' });

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    await waitFor(() => transport.requests.some((request) => request.method === 'turn/start'));

    expect(transport.requests[0]?.params.developerInstructions).toBe(
      buildBridgeSystemPrompt({ openId: 'ou_bot_self', name: 'Bridge' }),
    );
    expect(transport.requests[1]?.params.input).toEqual([
      { type: 'text', text: 'hi', text_elements: [] },
    ]);
  });

  it('falls back to the base developer instructions when no identity was set', async () => {
    const { adapter, transport } = codexAdapter();

    adapter.run({ runId: 'r1', prompt: 'hi', cwd: '/tmp' });
    await waitFor(() => transport.requests.some((request) => request.method === 'turn/start'));

    expect(transport.requests[0]?.params.developerInstructions).toBe(
      buildBridgeSystemPrompt(undefined),
    );
  });
});

async function readAll(stream: PassThrough): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
