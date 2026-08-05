import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeCotEvents,
  COT_MAX_EVENT_CONTENT_BYTES,
  COT_MAX_EVENTS_PER_UPDATE,
  CotClient,
  CotPublisher,
  cotBriefToolTitle,
  finalAnswerOnlyState,
} from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';
import type { RunState } from '../../../src/card/run-state.js';

describe('COT event mapping', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('publishes assistant progress text and brief tool summaries', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-1',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'draw a bear',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: '我会先生成图片。' },
      { type: 'tool_use', id: 'tool-1', name: 'command_execution', input: { command: 'echo bear' } },
      { type: 'tool_result', id: 'tool-1', output: 'ok', isError: false },
      { type: 'text', delta: '图片已经生成。' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    const eventTypes = client.events.map((event) => event.event_type);
    expect(eventTypes).toContain('TEXT_MESSAGE_START');
    expect(eventTypes).toContain('TEXT_MESSAGE_CONTENT');
    expect(eventTypes).toContain('TEXT_MESSAGE_END');
    expect(eventTypes).toContain('TOOL_CALL_START');
    expect(eventTypes).toContain('TOOL_CALL_RESULT');
    expect(eventTypes).not.toContain('TOOL_CALL_ARGS');

    const textDeltas = client.events
      .filter((event) => event.event_type === 'TEXT_MESSAGE_CONTENT')
      .map((event) => JSON.parse(event.content).delta);
    expect(textDeltas).toEqual(['我会先生成图片。', '图片已经生成。']);

    const toolResult = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(toolResult?.content ?? '{}').content).toContain('command_execution');
    expect(client.completed).toEqual(['done']);
  });

  it('includes tool args and output only in detailed mode', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-2',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      {
        type: 'tool_use',
        id: 'tool-1',
        name: 'command_execution',
        input: { command: 'x'.repeat(10_000) },
      },
      { type: 'tool_result', id: 'tool-1', output: 'workspace', isError: false },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    expect(client.events.map((event) => event.event_type)).toContain('TOOL_CALL_ARGS');
    const args = client.events.find((event) => event.event_type === 'TOOL_CALL_ARGS');
    const argsDelta = JSON.parse(args?.content ?? '{}').delta as string;
    expect(new TextEncoder().encode(argsDelta).byteLength).toBeLessThanOrEqual(3500);
    expect(argsDelta).toMatch(/\.\.\.$/);
    const result = client.events.find((event) => event.event_type === 'TOOL_CALL_RESULT');
    expect(JSON.parse(result?.content ?? '{}').content).toBe('workspace');
  });

  it('limits multibyte tool arguments by UTF-8 bytes', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-multibyte',
      scope: 'oc_chat',
      inputPreview: 'multibyte',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      {
        type: 'tool_use',
        id: 'tool-multibyte',
        name: 'command_execution',
        input: { command: '中🙂'.repeat(2_000) },
      },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'detailed' });

    const args = client.events.find((event) => event.event_type === 'TOOL_CALL_ARGS');
    const argsDelta = JSON.parse(args?.content ?? '{}').delta as string;
    expect(new TextEncoder().encode(argsDelta).byteLength).toBeLessThanOrEqual(3500);
    expect(argsDelta).toMatch(/\.\.\.$/);
  });

  it('drains buffered events in batches of at most twenty before completion', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-batched',
      scope: 'oc_chat',
      inputPreview: 'batch',
    });
    await publisher.start();
    for (let index = 0; index < 45; index += 1) {
      publisher.enqueue('TEXT_MESSAGE_CONTENT', {
        messageId: 'message-batched',
        delta: `chunk-${index}`,
      });
    }

    await publisher.finish('done');

    expect(client.updates.map((events) => events.length)).toEqual([20, 20, 7]);
    expect(client.events).toHaveLength(47);
    expect(client.completed).toEqual(['done']);
  });

  it('derives final answer state from text blocks only', () => {
    const state: RunState = {
      blocks: [
        { kind: 'tool', tool: { id: 'tool', name: 'command_execution', input: {}, status: 'done' } },
        { kind: 'text', content: 'final', streaming: false },
      ],
      reasoning: { content: 'hidden', active: true },
      footer: 'streaming',
      terminal: 'done',
    };

    expect(finalAnswerOnlyState(state)).toMatchObject({
      blocks: [{ kind: 'text', content: 'final' }],
      reasoning: { content: '', active: false },
      footer: null,
    });
  });

  it('uses the legacy tool header format for brief COT titles', () => {
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('✅ command_execution');
    expect(cotBriefToolTitle('command_execution', { command: 'echo hello' }, 'done'))
      .toContain('echo hello');
  });

  it('creates the CoT bubble once, addressed to the origin message in a topic', async () => {
    const client = new FakeCotClient();
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      // In a topic the trigger message is itself in-topic, so the bubble
      // inherits its thread. No thread_id is passed — message_cot rejects it.
      originMessageId: 'om_in_topic',
      runId: 'run-topic',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    // Exactly one create — never a second (that would render a duplicate).
    expect(client.createCalls).toEqual([
      { chatId: 'oc_chat', originMessageId: 'om_in_topic' },
    ]);
    expect(publisher.disabled).toBe(false);
  });

  it('disables the publisher when the create is rejected and never retries', async () => {
    const client = new FakeCotClient();
    client.failCreate = new Error('COT API failed: code=10002 msg=Bot/User can NOT be out of the chat.');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-rejected',
      scope: 'oc_chat:omt_topic',
      inputPreview: 'in a topic',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('disables the publisher when the create returns unusable ids and never retries', async () => {
    const client = new FakeCotClient();
    // code=0 response missing cot_id/message_id: the bubble may exist
    // server-side, so a second create would render a duplicate.
    client.createResult = { unexpected: 'shape' };
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-missing-ids',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    expect(client.createCalls).toHaveLength(1);
    expect(publisher.disabled).toBe(true);
  });

  it('addresses CoT create to the chat with the origin message id', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
    // Intercept the HTTP layer so we assert only how create() shapes the request.
    (client as unknown as { request: CotClient['request'] }).request = async (path, init) => {
      calls.push({ path, body: JSON.parse(String(init?.body ?? '{}')) });
      return { cot_id: 'cot_x', message_id: 'om_x' };
    };

    await client.create('oc_chat', 'om_origin');
    expect(calls[0]?.path).toContain('receive_id_type=chat_id');
    // thread_id is never a valid receive type for message_cot.
    expect(calls[0]?.path).not.toContain('thread_id');
    expect(calls[0]?.body).toMatchObject({ receive_id: 'oc_chat', origin_message_id: 'om_origin' });
  });

  it('preserves a bounded Feishu error body and request id for HTTP diagnostics', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        code: 0,
        tenant_access_token: 'test-token',
        expire: 7200,
      })))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ code: 230001, msg: 'events exceed the per-request limit' }),
        {
          status: 400,
          headers: { 'x-tt-logid': 'log-safe-123' },
        },
      ));
    vi.stubGlobal('fetch', fetchMock);
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });

    await expect(client.update(
      { cotId: 'cot_x', messageId: 'om_x' } as never,
      [{ event_type: 'RUN_STARTED', content: '{}', timestamp: Date.now() }],
    )).rejects.toThrow(
      'COT HTTP 400: {"code":230001,"msg":"events exceed the per-request limit"} (log_id=log-safe-123)',
    );
  });

  it('marks the publisher degraded when COT updates fail', async () => {
    const client = new FakeCotClient();
    client.failUpdate = new Error('field validation failed');
    const publisher = new CotPublisher({
      client,
      chatId: 'oc_chat',
      originMessageId: 'om_origin',
      runId: 'run-degraded',
      scope: 'oc_chat',
      inputPreview: 'run',
    });
    await publisher.start();

    await consumeCotEvents(iterate([
      { type: 'text', delta: 'working' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(publisher.disabled).toBe(true);
    expect(publisher.degradedReason).toBe('field validation failed');
    expect(client.completed).toEqual([]);
  });
});

describe('COT transport constraints', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('splits ordered updates into bounded batches', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    const batches: number[] = [];
    client.request = async (_path, init) => {
      const body = JSON.parse(String(init?.body)) as { events: unknown[] };
      batches.push(body.events.length);
      return {};
    };

    const events = Array.from({ length: COT_MAX_EVENTS_PER_UPDATE * 2 + 1 }, (_, index) => ({
      event_type: 'TEXT_MESSAGE_CONTENT',
      content: JSON.stringify({ delta: String(index) }),
      timestamp: index + 1,
    }));
    await client.update({ cotId: 'cot', messageId: 'message' }, events);

    expect(batches).toEqual([COT_MAX_EVENTS_PER_UPDATE, COT_MAX_EVENTS_PER_UPDATE, 1]);
  });

  it('accepts exactly 4096 UTF-8 bytes and rejects overflow before HTTP', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    let requests = 0;
    client.request = async () => {
      requests += 1;
      return {};
    };
    const event = (content: string) => ({ event_type: 'TEXT_MESSAGE_CONTENT', content, timestamp: 1 });

    await client.update(
      { cotId: 'cot', messageId: 'message' },
      [event('x'.repeat(COT_MAX_EVENT_CONTENT_BYTES))],
    );
    expect(requests).toBe(1);
    await expect(client.update(
      { cotId: 'cot', messageId: 'message' },
      [event('x'.repeat(COT_MAX_EVENT_CONTENT_BYTES + 1))],
    )).rejects.toThrow('exceeds 4096 bytes');
    expect(requests).toBe(1);
  });

  it('includes a truncated, redacted response body in HTTP diagnostics', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    vi.spyOn(client, 'tenantToken').mockResolvedValue('tenant-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      code: 99992402,
      msg: 'field validation failed',
      error: { field_violations: [{ field: 'events', description: 'the max len is 50' }] },
      tenant_access_token: 'must-not-appear',
    }), { status: 400 })));

    await expect(client.request('/open-apis/im/v1/message_cot')).rejects.toThrow(
      /COT HTTP 400.*field validation failed.*max len is 50.*REDACTED/,
    );
  });

  it('retries transient updates only a bounded number of times', async () => {
    const client = new CotClient({ tenant: 'feishu', appId: 'app', appSecret: 'secret' });
    vi.spyOn(client, 'tenantToken').mockResolvedValue('tenant-token');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"code":0,"msg":"success"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await client.update({ cotId: 'cot', messageId: 'message' }, [{
      event_type: 'RUN_STARTED',
      content: '{}',
      timestamp: 1,
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

class FakeCotClient {
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  updates: Array<Array<{ event_type: string; content: string; timestamp: number }>> = [];
  completed: string[] = [];
  createCalls: Array<{ chatId: string; originMessageId?: string }> = [];
  failUpdate: Error | undefined;
  failCreate: Error | undefined;
  createResult: Record<string, unknown> | undefined;

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    this.createCalls.push({ chatId, originMessageId });
    if (this.failCreate) throw this.failCreate;
    return this.createResult ?? { cot_id: 'cot_fake', message_id: 'om_cot_fake' };
  }

  async update(_ref: unknown, events: readonly { event_type: string; content: string; timestamp: number }[]): Promise<void> {
    if (this.failUpdate) throw this.failUpdate;
    this.updates.push([...events]);
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}
