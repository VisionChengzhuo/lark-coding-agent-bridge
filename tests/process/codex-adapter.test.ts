import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/agent/codex/adapter.js';
import type {
  AppServerExit,
  CodexAppServerTransport,
  JsonRpcNotification,
} from '../../src/agent/codex/app-server-client.js';
import type { AgentEvent, AgentRun } from '../../src/agent/types.js';

interface RecordedRequest {
  method: string;
  params: Record<string, unknown>;
}

class FakeAppServer implements CodexAppServerTransport {
  readonly requests: RecordedRequest[] = [];
  readonly notifications = new Set<(notification: JsonRpcNotification) => void>();
  readonly exits = new Set<(exit: AppServerExit) => void>();
  started = false;
  closed = false;
  nextThread = 1;
  nextTurn = 1;

  async ensureStarted(): Promise<void> {
    this.started = true;
  }

  async request<T>(method: string, rawParams?: unknown): Promise<T> {
    const params = (rawParams ?? {}) as Record<string, unknown>;
    this.requests.push({ method, params });
    if (method === 'thread/start') {
      const id = `thread-${this.nextThread++}`;
      return { thread: { id }, model: 'default-model', cwd: params.cwd } as T;
    }
    if (method === 'thread/resume') {
      return {
        thread: { id: params.threadId },
        model: 'default-model',
        cwd: params.cwd,
      } as T;
    }
    if (method === 'turn/start') {
      return { turn: { id: `turn-${this.nextTurn++}` } } as T;
    }
    if (method === 'model/list') {
      return {
        data: [
          {
            id: 'gpt-test',
            model: 'gpt-test',
            displayName: 'GPT Test',
            description: 'Test model',
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: 'medium',
            supportedReasoningEfforts: [
              { reasoningEffort: 'low', description: 'Fast' },
              { reasoningEffort: 'medium', description: 'Balanced' },
            ],
          },
        ],
        nextCursor: null,
      } as T;
    }
    if (method === 'turn/interrupt') return {} as T;
    throw new Error(`unexpected request ${method}`);
  }

  async notify(): Promise<void> {}

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notifications.add(listener);
    return () => this.notifications.delete(listener);
  }

  onExit(listener: (exit: AppServerExit) => void): () => void {
    this.exits.add(listener);
    return () => this.exits.delete(listener);
  }

  pid(): number {
    return 4242;
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  emit(method: string, params: unknown): void {
    for (const listener of [...this.notifications]) listener({ method, params });
  }

  crash(): void {
    for (const listener of [...this.exits]) {
      listener({ code: 17, signal: null, expected: false, stderr: 'crashed' });
    }
  }
}

describe('CodexAdapter App Server protocol', () => {
  it('starts a new thread, starts a turn, and maps text deltas to one terminal event', async () => {
    const server = new FakeAppServer();
    const accepted: Array<{ threadId: string; turnId: string }> = [];
    const run = adapter(server).run({
      runId: 'run-new',
      prompt: 'hello',
      cwd: '/repo',
      onTurnAccepted: (value) => {
        accepted.push(value);
      },
    });
    const eventsPromise = collect(run);
    await waitForRequest(server, 'turn/start');

    server.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'hello ',
    });
    server.emit('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'msg-1',
      delta: 'user',
    });
    server.emit('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', id: 'msg-1', text: 'hello user' },
    });
    server.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });
    server.emit('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', status: 'completed' },
    });

    const events = await eventsPromise;
    expect(server.requests.map((request) => request.method)).toEqual([
      'thread/start',
      'turn/start',
    ]);
    expect(events).toEqual([
      { type: 'system', threadId: 'thread-1', cwd: '/repo', model: 'default-model' },
      { type: 'system', threadId: 'thread-1', turnId: 'turn-1', cwd: '/repo' },
      { type: 'text', delta: 'hello ' },
      { type: 'text', delta: 'user' },
      { type: 'final_text', content: 'hello user' },
      { type: 'done', threadId: 'thread-1', terminationReason: 'normal' },
    ]);
    expect(accepted).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
  });

  it('resumes the requested thread and passes images, cwd, model, and sandbox policy', async () => {
    const server = new FakeAppServer();
    const run = adapter(server).run({
      runId: 'run-resume',
      prompt: 'continue',
      cwd: '/repo',
      threadId: 'thread-old',
      images: ['/tmp/image.png'],
      sandbox: 'read-only',
      model: 'configured-model',
      reasoningEffort: 'high',
    });
    const eventsPromise = collect(run);
    await waitForRequest(server, 'turn/start');
    server.emit('turn/completed', {
      threadId: 'thread-old',
      turn: { id: 'turn-1', status: 'completed' },
    });
    await eventsPromise;

    expect(server.requests.map((request) => request.method)).toEqual([
      'thread/resume',
      'turn/start',
    ]);
    expect(server.requests[0]?.params).toMatchObject({
      threadId: 'thread-old',
      cwd: '/repo',
      model: 'configured-model',
      sandbox: 'read-only',
      approvalPolicy: 'never',
    });
    expect(server.requests[1]?.params).toMatchObject({
      threadId: 'thread-old',
      cwd: '/repo',
      model: 'configured-model',
      effort: 'high',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
      input: [
        { type: 'text', text: 'continue', text_elements: [] },
        { type: 'localImage', path: '/tmp/image.png' },
      ],
    });
  });

  it('lists the account model catalog with supported reasoning efforts', async () => {
    const server = new FakeAppServer();

    await expect(adapter(server).listModels()).resolves.toEqual([
      {
        value: 'gpt-test',
        label: 'GPT Test',
        description: 'Test model',
        isDefault: true,
        defaultReasoningEffort: 'medium',
        supportedReasoningEfforts: [
          { value: 'low', description: 'Fast' },
          { value: 'medium', description: 'Balanced' },
        ],
      },
    ]);
    expect(server.requests.at(-1)).toEqual({
      method: 'model/list',
      params: { includeHidden: false, limit: 100 },
    });
  });

  it('maps command, file-change, and MCP tool lifecycle events', async () => {
    const server = new FakeAppServer();
    const run = adapter(server).run({ runId: 'tools', prompt: 'work', cwd: '/repo' });
    const eventsPromise = collect(run);
    await waitForRequest(server, 'turn/start');

    server.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', status: 'inProgress' },
    });
    server.emit('item/commandExecution/outputDelta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd-1', delta: '/repo\n',
    });
    server.emit('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'commandExecution', id: 'cmd-1', command: 'pwd', status: 'completed' },
    });
    server.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'file-1', changes: [{ path: 'a.ts' }], status: 'inProgress' },
    });
    server.emit('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'fileChange', id: 'file-1', changes: [{ path: 'a.ts' }], status: 'completed' },
    });
    server.emit('item/started', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'lark', tool: 'get', arguments: { id: 1 }, status: 'inProgress' },
    });
    server.emit('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'mcpToolCall', id: 'mcp-1', server: 'lark', tool: 'get', result: { ok: true }, status: 'completed' },
    });
    server.emit('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    });

    expect(await eventsPromise).toEqual(expect.arrayContaining([
      { type: 'tool_use', id: 'cmd-1', name: 'command_execution', input: { command: 'pwd' } },
      { type: 'tool_result', id: 'cmd-1', output: '/repo\n', isError: false },
      { type: 'tool_use', id: 'file-1', name: 'file_change', input: [{ path: 'a.ts' }] },
      { type: 'tool_result', id: 'file-1', output: '[{"path":"a.ts"}]', isError: false },
      { type: 'tool_use', id: 'mcp-1', name: 'lark.get', input: { id: 1 } },
      { type: 'tool_result', id: 'mcp-1', output: '{"ok":true}', isError: false },
    ]));
  });

  it('interrupts only the active turn and keeps the shared App Server alive', async () => {
    const server = new FakeAppServer();
    const run = adapter(server).run({ runId: 'stop', prompt: 'sleep', cwd: '/repo' });
    const eventsPromise = collect(run);
    await waitForRequest(server, 'turn/start');

    await run.stop();
    expect(server.requests.at(-1)).toEqual({
      method: 'turn/interrupt',
      params: { threadId: 'thread-1', turnId: 'turn-1' },
    });
    expect(server.closed).toBe(false);
    server.emit('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' },
    });
    await expect(eventsPromise).resolves.toContainEqual({
      type: 'done', threadId: 'thread-1', terminationReason: 'interrupted',
    });
  });

  it('isolates two concurrent turns by thread and turn id', async () => {
    const server = new FakeAppServer();
    const first = adapter(server).run({ runId: 'a', prompt: 'a', cwd: '/a' });
    const second = adapter(server).run({ runId: 'b', prompt: 'b', cwd: '/b' });
    const firstEvents = collect(first);
    const secondEvents = collect(second);
    await waitForRequestCount(server, 'turn/start', 2);

    server.emit('item/agentMessage/delta', {
      threadId: 'thread-2', turnId: 'turn-2', itemId: 'b', delta: 'B',
    });
    server.emit('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'a', delta: 'A',
    });
    server.emit('turn/completed', {
      threadId: 'thread-2', turn: { id: 'turn-2', status: 'completed' },
    });
    server.emit('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    });

    expect(await firstEvents).toContainEqual({ type: 'text', delta: 'A' });
    expect(await firstEvents).not.toContainEqual({ type: 'text', delta: 'B' });
    expect(await secondEvents).toContainEqual({ type: 'text', delta: 'B' });
    expect(await secondEvents).not.toContainEqual({ type: 'text', delta: 'A' });
  });

  it('fails the in-flight run on server crash and does not replay its turn', async () => {
    const server = new FakeAppServer();
    const run = adapter(server).run({ runId: 'crash', prompt: 'once', cwd: '/repo' });
    const eventsPromise = collect(run);
    await waitForRequest(server, 'turn/start');
    const requestCount = server.requests.length;

    server.crash();

    expect(await eventsPromise).toContainEqual({
      type: 'error',
      message: 'codex app-server exited unexpectedly with code 17',
      terminationReason: 'failed',
    });
    expect(server.requests).toHaveLength(requestCount);
  });

  it('treats retrying error notifications as non-terminal until turn completion', async () => {
    const server = new FakeAppServer();
    const run = adapter(server).run({ runId: 'retry', prompt: 'retry', cwd: '/repo' });
    const eventsPromise = collect(run);
    await waitForRequest(server, 'turn/start');
    server.emit('error', {
      threadId: 'thread-1', turnId: 'turn-1', willRetry: true, error: { message: 'reconnecting' },
    });
    server.emit('item/agentMessage/delta', {
      threadId: 'thread-1', turnId: 'turn-1', itemId: 'm', delta: 'recovered',
    });
    server.emit('turn/completed', {
      threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' },
    });

    const events = await eventsPromise;
    expect(events).toContainEqual({ type: 'text', delta: 'recovered' });
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
  });
});

function adapter(server: FakeAppServer): CodexAdapter {
  return new CodexAdapter({
    binary: process.execPath,
    profileStateDir: '/profile',
    client: server,
  });
}

async function collect(run: AgentRun): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of run.events) events.push(event);
  return events;
}

async function waitForRequest(server: FakeAppServer, method: string): Promise<void> {
  return waitForRequestCount(server, method, 1);
}

async function waitForRequestCount(
  server: FakeAppServer,
  method: string,
  count: number,
): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (server.requests.filter((request) => request.method === method).length < count) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${method}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}
