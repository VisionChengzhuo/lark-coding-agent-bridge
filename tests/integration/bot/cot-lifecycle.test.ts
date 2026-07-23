import { describe, expect, it } from 'vitest';
import { consumeCotEvents, CotPublisher } from '../../../src/bot/cot.js';
import type { AgentEvent } from '../../../src/agent/types.js';

describe('COT lifecycle integration', () => {
  it('keeps create, ordered update, complete, and final-answer handoff intact', async () => {
    const api = new FakeCotApi();
    const publisher = new CotPublisher({
      client: api,
      chatId: 'oc_owner_dm',
      originMessageId: 'om_test_input',
      runId: 'run-KML_COT_FIX_TEST',
      scope: 'oc_owner_dm',
      inputPreview: 'KML_COT_FIX_TEST',
    });

    await publisher.start();
    await consumeCotEvents(iterate([
      { type: 'text', delta: 'COT_FIX_OK' },
      { type: 'done', terminationReason: 'normal' },
    ]), publisher, { detail: 'brief' });

    expect(api.operations[0]).toBe('create');
    expect(api.events.map((event) => event.event_type)).toEqual(expect.arrayContaining([
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'RUN_FINISHED',
    ]));
    expect(api.operations.at(-1)).toBe('complete');
    expect(api.completed).toEqual(['done']);
  });
});

class FakeCotApi {
  operations: string[] = [];
  events: Array<{ event_type: string; content: string; timestamp: number }> = [];
  completed: string[] = [];

  async create(): Promise<Record<string, unknown>> {
    this.operations.push('create');
    return { cot_id: 'cot_test', message_id: 'om_cot_test' };
  }

  async update(
    _ref: unknown,
    events: readonly { event_type: string; content: string; timestamp: number }[],
  ): Promise<void> {
    this.operations.push('update');
    this.events.push(...events);
  }

  async complete(_ref: unknown, reason: string): Promise<void> {
    this.operations.push('complete');
    this.completed.push(reason);
  }
}

async function* iterate(events: readonly AgentEvent[]): AsyncIterable<AgentEvent> {
  for (const event of events) yield event;
}
