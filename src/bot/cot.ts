import type { AgentEvent } from '../agent/types';
import type { CotMessagesMode, TenantBrand } from '../config/schema';
import { log } from '../core/logger';
import { toolHeaderText } from '../card/tool-render';
import type { RunState } from '../card/run-state';

const ENDPOINTS: Record<TenantBrand, string> = {
  feishu: 'https://open.feishu.cn',
  lark: 'https://open.larksuite.com',
};

export const COT_UPDATE_THROTTLE_MS = 600;
// Keep a conservative batch size below Feishu's documented/runtime limit so
// a burst remains valid and ordered even if the limit changes per tenant.
export const COT_MAX_EVENTS_PER_UPDATE = 20;
export const COT_MAX_EVENT_CONTENT_BYTES = 4096;
const COT_TOOL_OUTPUT_MAX = 1200;
// Feishu caps each serialized event content at 4096 UTF-8 bytes. Keep enough
// room for the JSON wrapper and toolCallId around the argument delta.
const COT_TOOL_ARGS_MAX = 3500;
const COT_TEXT_MAX = 1200;
// Bounds every CoT HTTP call. Without it a hung message_cot endpoint pins
// start() — which runs before any agent event is drained and before the
// plain-reply fallback — to undici's ~300s default.
const COT_REQUEST_TIMEOUT_MS = 15_000;

class CotHttpError extends Error {
  readonly status: number;

  constructor(status: number, body: string, logId?: string | null) {
    const detail = safeCotErrorDetail(body);
    super(
      `COT HTTP ${status}` +
        (detail ? `: ${detail}` : '') +
        (logId ? ` (log_id=${logId.slice(0, 128)})` : ''),
    );
    this.name = 'CotHttpError';
    this.status = status;
  }
}

class CotApiError extends Error {
  readonly status: number;
  readonly code: number;

  constructor(status: number, code: number, message: string, body: string) {
    super(`COT API failed: code=${code} msg=${message || '<no msg>'}: ${safeCotErrorDetail(body)}`);
    this.name = 'CotApiError';
    this.status = status;
    this.code = code;
  }
}

export class CotClient {
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly appSecret: string;
  private token: string | undefined;
  private tokenExpiresAt = 0;

  constructor(opts: { tenant: TenantBrand; appId: string; appSecret: string }) {
    this.baseUrl = ENDPOINTS[opts.tenant];
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
  }

  async tenantToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.tokenExpiresAt - now > 60_000) return this.token;
    const resp = await fetch(`${this.baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: this.appId, app_secret: this.appSecret }),
      signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
    });
    const text = await resp.text();
    if (!resp.ok) {
      throw new CotHttpError(
        resp.status,
        text,
        resp.headers.get('x-tt-logid') ?? resp.headers.get('x-request-id'),
      );
    }
    const data = parseJson(text) as {
      code?: number;
      msg?: string;
      tenant_access_token?: string;
      expire?: number;
    };
    if (data.code !== 0 || !data.tenant_access_token) {
      throw new CotApiError(resp.status, data.code ?? -1, data.msg ?? '', text);
    }
    this.token = data.tenant_access_token;
    const expireSeconds = typeof data.expire === 'number' ? data.expire : 7200;
    this.tokenExpiresAt = now + Math.max(60, expireSeconds - 60) * 1000;
    return this.token;
  }

  async request(
    path: string,
    init: RequestInit = {},
    opts: { retryable?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    let attempt = 0;
    while (true) {
      try {
        const token = await this.tenantToken();
        const resp = await fetch(`${this.baseUrl}${path}`, {
          signal: AbortSignal.timeout(COT_REQUEST_TIMEOUT_MS),
          ...init,
          headers: {
            'Content-Type': 'application/json;charset=utf-8',
            Authorization: `Bearer ${token}`,
            ...(init.headers ?? {}),
          },
        });
        const text = await resp.text();
        if (!resp.ok) {
          throw new CotHttpError(
            resp.status,
            text,
            resp.headers.get('x-tt-logid') ?? resp.headers.get('x-request-id'),
          );
        }
        if (!text) return {};
        const data = parseJson(text) as {
          code?: number;
          msg?: string;
          data?: Record<string, unknown>;
        } & Record<string, unknown>;
        if (data.code !== undefined && data.code !== 0) {
          throw new CotApiError(resp.status, data.code, data.msg ?? '', text);
        }
        return data.data ?? data;
      } catch (err) {
        if (!opts.retryable || attempt >= 2 || !isTransientCotError(err)) throw err;
        const delayMs = [120, 300][attempt] ?? 0;
        attempt += 1;
        log.warn('cot', 'retrying', {
          attempt,
          delayMs,
          status: statusOf(err),
          err: diagnosticError(err),
        });
        await delay(delayMs);
      }
    }
  }

  async create(chatId: string, originMessageId?: string): Promise<Record<string, unknown>> {
    // message_cot only accepts receive_id_type=chat_id. thread_id is NOT a
    // valid receive type for this endpoint (it exists only on the forward
    // APIs) — addressing the create to an omt_* thread id is rejected with
    // code=10002 "Bot/User can NOT be out of the chat" (the backend tries to
    // resolve the omt_* id as a chat the bot belongs to and finds none).
    //
    // Placement inside a topic is instead governed by origin_message_id: the
    // bubble inherits the topic of the message it originates from. Passing an
    // in-topic message id keeps the bubble in the topic; the topic's root
    // (首楼) message has no thread of its own, so a bubble originated from it
    // lands at the group top level. Callers pick origin_message_id
    // accordingly.
    return this.request('/open-apis/im/v1/message_cot?receive_id_type=chat_id', {
      method: 'POST',
      body: JSON.stringify({
        receive_id: chatId,
        ...(originMessageId ? { origin_message_id: originMessageId } : {}),
      }),
    });
  }

  async update(ref: CotRef, events: readonly CotEvent[]): Promise<void> {
    if (events.length === 0) return;
    for (const event of events) validateCotEvent(event);
    // Feishu rejects the whole request when the event array is too large.
    // Sequential chunks preserve event order and avoid racing its append cursor.
    for (let start = 0; start < events.length; start += COT_MAX_EVENTS_PER_UPDATE) {
      const batch = events.slice(start, start + COT_MAX_EVENTS_PER_UPDATE);
      await this.request('/open-apis/im/v1/message_cot', {
        method: 'PUT',
        body: JSON.stringify({
          cot_id: ref.cotId,
          message_id: ref.messageId,
          events: batch,
        }),
      }, { retryable: true });
    }
  }

  async complete(ref: CotRef, reason: string): Promise<void> {
    const cotId = encodeURIComponent(ref.cotId);
    const messageId = encodeURIComponent(ref.messageId);
    await this.request(
      `/open-apis/im/v1/message_cot/complete/${cotId}?message_id=${messageId}&reason=${encodeURIComponent(reason)}`,
      { method: 'POST', body: '' },
      { retryable: true },
    );
  }
}

interface CotRef {
  cotId: string;
  messageId: string;
}

interface CotEvent {
  event_type: string;
  content: string;
  timestamp: number;
}

export class CotPublisher {
  private readonly client: Pick<CotClient, 'create' | 'update' | 'complete'>;
  readonly chatId: string;
  readonly originMessageId: string;
  readonly runId: string;
  readonly scope: string;
  readonly inputPreview: string;
  ref: CotRef | undefined;
  disabled = false;
  degradedReason: string | undefined;
  private buffer: CotEvent[] = [];
  private flushing: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  private lastTimestamp = 0;

  constructor(opts: {
    client: Pick<CotClient, 'create' | 'update' | 'complete'>;
    chatId: string;
    originMessageId: string;
    runId: string;
    scope: string;
    inputPreview: string;
  }) {
    this.client = opts.client;
    this.chatId = opts.chatId;
    this.originMessageId = opts.originMessageId;
    this.runId = opts.runId;
    this.scope = opts.scope;
    this.inputPreview = opts.inputPreview;
  }

  async start(): Promise<void> {
    // Single chat_id-addressed create. In topics the bubble follows
    // originMessageId's thread (see CotClient.create); the caller passes an
    // in-topic origin so it lands in the topic. On any failure we disable CoT
    // and let the caller fall back to a plain reply — never retry, since a
    // create that failed after committing server-side would leave a duplicate
    // bubble spinning forever.
    let created: Record<string, unknown>;
    try {
      created = await this.client.create(this.chatId, this.originMessageId);
    } catch (err) {
      this.disabled = true;
      log.warn('cot', 'create-failed', { err: diagnosticError(err) });
      return;
    }
    const cotId = stringValue(created.cot_id ?? created.cotId);
    const messageId = stringValue(created.message_id ?? created.messageId);
    if (!cotId || !messageId) {
      this.disabled = true;
      log.warn('cot', 'create-failed', {
        err: `CreateCOT missing ids: ${diagnosticResponse(JSON.stringify(created))}`,
      });
      return;
    }
    this.ref = { cotId, messageId };
    log.info('cot', 'created', { cotId, messageId });
    this.enqueue('RUN_STARTED', {
      threadId: this.scope,
      runId: this.runId,
      input: { query: truncateCot(this.inputPreview, COT_TEXT_MAX) },
    });
    this.enqueue('STEP_STARTED', {
      stepId: `step-understand-${this.runId}`,
      stepName: '理解用户问题',
    });
  }

  enqueue(eventType: string, content: unknown): void {
    if (this.disabled || !this.ref) return;
    this.buffer.push({
      event_type: eventType,
      content: boundedJsonContent(content),
      timestamp: this.nextTimestamp(),
    });
    this.scheduleFlush();
  }

  async finish(reason: string): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.flush();
    if (this.disabled || !this.ref) return;
    try {
      await this.client.complete(this.ref, reason);
      log.info('cot', 'completed', { cotId: this.ref.cotId, reason });
    } catch (err) {
      log.warn('cot', 'complete-failed', { err: diagnosticError(err) });
    }
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = Math.max(now, this.lastTimestamp + 1);
    return this.lastTimestamp;
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, COT_UPDATE_THROTTLE_MS);
  }

  private async flush(): Promise<void> {
    if (this.disabled || !this.ref) return;
    if (this.flushing) {
      await this.flushing;
      if (this.buffer.length > 0 && !this.disabled) await this.flush();
      return;
    }
    const events = this.buffer.splice(0, COT_MAX_EVENTS_PER_UPDATE);
    if (events.length === 0) return;
    this.flushing = this.client.update(this.ref, events)
      .catch((err) => {
        this.disabled = true;
        this.degradedReason = diagnosticError(err);
        log.warn('cot', 'update-failed', { err: this.degradedReason });
      })
      .finally(() => {
        this.flushing = undefined;
      });
    await this.flushing;
    // Events can arrive while an update is in flight. Drain them in bounded
    // batches before returning so finish() never completes the COT while
    // buffered events are still waiting for a throttle timer.
    if (this.buffer.length > 0 && !this.disabled) await this.flush();
  }
}

export function finalAnswerOnlyState(state: RunState): RunState {
  return {
    ...state,
    blocks: state.finalText
      ? [{ kind: 'text', content: state.finalText, streaming: false }]
      : state.blocks.filter((b) => b.kind === 'text'),
    reasoning: { content: '', active: false },
    footer: null,
  };
}

export async function consumeCotEvents(
  events: AsyncIterable<AgentEvent>,
  publisher: CotPublisher,
  opts: { detail: CotMessagesMode },
): Promise<void> {
  let reasoningOpen = false;
  let textStepOpen = false;
  let textMessageOpen = false;
  let textMessageIndex = 0;
  let textMessageId: string | undefined;
  const toolBrief = new Map<string, { name: string; input: unknown }>();
  const reasoningMessageId = `reasoning-${publisher.runId}`;
  const finalStepId = `step-process-${publisher.runId}`;

  try {
    for await (const evt of events) {
      if (evt.type === 'system' || evt.type === 'usage') continue;
      if (evt.type === 'thinking') {
        closeTextIfNeeded();
        if (!reasoningOpen) {
          reasoningOpen = true;
          publisher.enqueue('REASONING_START', { messageId: reasoningMessageId });
          publisher.enqueue('REASONING_MESSAGE_START', {
            messageId: reasoningMessageId,
            role: 'reasoning',
          });
        }
        publisher.enqueue('REASONING_MESSAGE_CONTENT', {
          messageId: reasoningMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'tool_use') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        const toolCallId = evt.id;
        const detailed = opts.detail === 'detailed';
        const showSummary = opts.detail === 'brief' || detailed;
        const title = showSummary ? cotBriefToolTitle(evt.name, evt.input, 'running') : '正在调用工具';
        toolBrief.set(toolCallId, { name: evt.name, input: evt.input });
        publisher.enqueue('TOOL_CALL_START', {
          toolCallId,
          icon: showSummary ? cotToolIcon(evt.name) : 'default',
          title,
          toolCallName: showSummary ? evt.name : 'tool',
        });
        if (detailed && evt.input !== undefined) {
          publisher.enqueue('TOOL_CALL_ARGS', {
            toolCallId,
            // Feishu rejects oversized event content with code=10001.
            // Tool inputs (especially shell commands and patches) are the
            // only unbounded event field in the normal mapping.
            delta: truncateCot(JSON.stringify(evt.input), COT_TOOL_ARGS_MAX),
          });
        }
        publisher.enqueue('TOOL_CALL_END', { toolCallId });
        continue;
      }
      if (evt.type === 'tool_result') {
        const detailed = opts.detail === 'detailed';
        const brief = toolBrief.get(evt.id);
        publisher.enqueue('TOOL_CALL_RESULT', {
          messageId: `tool-result-${evt.id}`,
          toolCallId: evt.id,
          role: 'tool',
          content: detailed
            ? truncateCot(evt.output ?? '', COT_TOOL_OUTPUT_MAX)
            : brief
              ? cotBriefToolTitle(brief.name, brief.input, evt.isError ? 'error' : 'done')
              : '工具调用已完成',
        });
        toolBrief.delete(evt.id);
        continue;
      }
      if (evt.type === 'text') {
        closeReasoningIfNeeded();
        if (!textStepOpen) {
          textStepOpen = true;
          publisher.enqueue('STEP_STARTED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (!textMessageOpen) {
          textMessageOpen = true;
          textMessageId = `text-${publisher.runId}-${++textMessageIndex}`;
          publisher.enqueue('TEXT_MESSAGE_START', { messageId: textMessageId, role: 'assistant' });
        }
        publisher.enqueue('TEXT_MESSAGE_CONTENT', {
          messageId: textMessageId,
          delta: truncateCot(evt.delta, COT_TEXT_MAX),
        });
        continue;
      }
      if (evt.type === 'final_text') continue;
      if (evt.type === 'done' || evt.type === 'error') {
        closeReasoningIfNeeded();
        closeTextIfNeeded();
        if (textStepOpen) {
          publisher.enqueue('STEP_FINISHED', {
            stepId: finalStepId,
            stepName: '输出过程',
          });
        }
        if (evt.type === 'error') {
          publisher.enqueue('RUN_ERROR', {
            message: truncateCot(evt.message, COT_TEXT_MAX),
            code: evt.terminationReason ?? 'error',
          });
          await publisher.finish('error');
        } else {
          const status = evt.terminationReason === 'normal' ? 'done' : evt.terminationReason ?? 'done';
          publisher.enqueue('RUN_FINISHED', {
            threadId: publisher.scope,
            runId: publisher.runId,
            status,
          });
          await publisher.finish(status === 'done' ? 'done' : 'error');
        }
        return;
      }
    }
    closeReasoningIfNeeded();
    closeTextIfNeeded();
    await publisher.finish('done');
  } catch (err) {
    log.warn('cot', 'consume-failed', { err: diagnosticError(err) });
    await publisher.finish('error');
  }

  function closeReasoningIfNeeded(): void {
    if (!reasoningOpen) return;
    reasoningOpen = false;
    publisher.enqueue('REASONING_MESSAGE_END', { messageId: reasoningMessageId });
    publisher.enqueue('REASONING_END', { messageId: reasoningMessageId });
  }

  function closeTextIfNeeded(): void {
    if (!textMessageOpen || !textMessageId) return;
    publisher.enqueue('TEXT_MESSAGE_END', { messageId: textMessageId });
    textMessageOpen = false;
    textMessageId = undefined;
  }
}

export function cotBriefToolTitle(
  name: string,
  input: unknown,
  status: 'running' | 'done' | 'error' = 'running',
): string {
  return toolHeaderText({ id: 'cot-tool', name, input, status }).replace(/\*\*/g, '');
}

function cotToolIcon(name: string): string {
  const lower = String(name ?? '').toLowerCase();
  if (lower.includes('search') || lower.includes('grep') || lower.includes('rg')) return 'search';
  if (lower.includes('read')) return 'read';
  if (lower.includes('write') || lower.includes('edit')) return 'write';
  if (lower.includes('doc')) return 'doc';
  if (lower.includes('calendar')) return 'calendar';
  if (lower.includes('task')) return 'task';
  if (lower.includes('command') || lower.includes('bash')) return 'bash';
  return 'default';
}

function truncateCot(value: unknown, max: number): string {
  const text = String(value ?? '');
  const encoder = new TextEncoder();
  if (encoder.encode(text).byteLength <= max) return text;
  const suffix = '...';
  const contentLimit = Math.max(0, max - encoder.encode(suffix).byteLength);
  const chunks: string[] = [];
  let byteLength = 0;
  for (const character of text) {
    const characterBytes = encoder.encode(character).byteLength;
    if (byteLength + characterBytes > contentLimit) break;
    chunks.push(character);
    byteLength += characterBytes;
  }
  return `${chunks.join('')}${suffix}`;
}

function validateCotEvent(event: CotEvent): void {
  if (!event.event_type) throw new Error('COT event_type is empty');
  if (typeof event.content !== 'string') throw new Error('COT event content must be a string');
  const contentBytes = Buffer.byteLength(event.content, 'utf8');
  if (contentBytes > COT_MAX_EVENT_CONTENT_BYTES) {
    throw new Error(`COT event content exceeds ${COT_MAX_EVENT_CONTENT_BYTES} bytes (${contentBytes})`);
  }
  if (!Number.isInteger(event.timestamp) || event.timestamp < 0) {
    throw new Error('COT event timestamp must be a non-negative integer');
  }
}

function boundedJsonContent(value: unknown): string {
  const json = JSON.stringify(value) ?? 'null';
  if (Buffer.byteLength(json, 'utf8') <= COT_MAX_EVENT_CONTENT_BYTES) return json;

  const marker = '…';
  let low = 0;
  let high = Buffer.byteLength(json, 'utf8');
  let best = JSON.stringify({ text: marker });
  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate = JSON.stringify({ text: `${truncateCot(json, mid)}${marker}` });
    if (Buffer.byteLength(candidate, 'utf8') <= COT_MAX_EVENT_CONTENT_BYTES) {
      best = candidate;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return best;
}

function parseJson(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`COT response was not JSON: ${String(err).slice(0, 160)}`);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function safeCotErrorDetail(value: string): string {
  if (!value) return '';
  const redacted = value
    .replace(
      /("(?:app[_-]?secret|appSecret|tenant_access_token|access_token|authorization|token|password|credential)"\s*:\s*")[^"]*(")/gi,
      '$1[REDACTED]$2',
    )
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/((?:app[_-]?secret|tenant_access_token|access_token|authorization|token|password)\s*[=:]\s*)[^,;\s}]+/gi, '$1[REDACTED]');
  const compact = redacted.replace(/\s+/g, ' ').trim();
  return truncateCot(compact, 1000);
}

function diagnosticResponse(value: string): string {
  return safeCotErrorDetail(value);
}

function diagnosticError(err: unknown): string {
  return err instanceof Error ? safeCotErrorDetail(err.message) : safeCotErrorDetail(String(err));
}

function statusOf(err: unknown): number | undefined {
  return err instanceof CotHttpError || err instanceof CotApiError ? err.status : undefined;
}

function isTransientCotError(err: unknown): boolean {
  const status = statusOf(err);
  if (status !== undefined) return status === 408 || status === 425 || status === 429 || status >= 500;
  if (!(err instanceof Error)) return false;
  return err.name === 'AbortError' || err.name === 'TimeoutError' || err.name === 'TypeError';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
