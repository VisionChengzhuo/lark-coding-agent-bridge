import type { LarkChannel } from '@larksuite/channel';

export const MAX_GROUP_CONTEXT_MESSAGES = 30;
export const MAX_GROUP_CONTEXT_CHARS = 24_000;
export const MAX_GROUP_CONTEXT_AGE_MS = 24 * 60 * 60 * 1_000;

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export interface GroupContextCursor {
  lastCreatedAtMs: number;
  messageIdsAtLastCreatedAt: string[];
}

export interface GroupContextAttachment {
  type: string;
  fileName?: string;
}

export interface GroupContextMessage {
  messageId: string;
  createdAt: string;
  createdAtMs: number;
  senderId: string;
  senderName: string;
  senderType: 'user' | 'bot';
  rawContentType: string;
  content: string;
  attachments?: GroupContextAttachment[];
}

export type GroupContextStatus = 'full' | 'truncated' | 'degraded';

export interface GroupContextResult {
  chatId: string;
  chatMode: 'group' | 'topic';
  threadId?: string;
  status: GroupContextStatus;
  truncated: boolean;
  degradedReason?: string;
  messages: GroupContextMessage[];
  messageCount: number;
  charCount: number;
  cursorCandidate: GroupContextCursor;
}

export interface FetchGroupContextInput {
  channel: LarkChannel;
  chatId: string;
  chatMode: 'group' | 'topic';
  threadId?: string;
  triggerCreatedAtMs: number;
  triggerMessageIds: readonly string[];
  excludedMessageIds?: ReadonlySet<string>;
  botOpenId?: string;
  cursor?: GroupContextCursor;
  maxMessages?: number;
  maxChars?: number;
  maxAgeMs?: number;
}

interface RawMessageItem {
  message_id?: string;
  thread_id?: string;
  chat_id?: string;
  msg_type?: string;
  create_time?: string;
  sender?: {
    id?: string;
    sender_type?: string;
    sender_name?: string;
  };
  body?: { content?: string };
  mentions?: Array<{ key?: string; name?: string }>;
}

export async function fetchGroupContext(
  input: FetchGroupContextInput,
): Promise<GroupContextResult> {
  if (input.chatMode === 'topic' && !input.threadId) {
    return degraded(input, 'topic-thread-id-missing');
  }
  const maxAgeMs = input.maxAgeMs ?? MAX_GROUP_CONTEXT_AGE_MS;
  const oldestAllowedMs = input.triggerCreatedAtMs - maxAgeMs;
  const rawItems: RawMessageItem[] = [];
  let pageToken: string | undefined;
  let hasMore = false;
  let degradedReason: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const response = await input.channel.rawClient.im.v1.message.list({
        params: {
          container_id_type: input.chatMode === 'topic' ? 'thread' : 'chat',
          container_id: input.chatMode === 'topic' ? input.threadId! : input.chatId,
          start_time: String(Math.floor(oldestAllowedMs / 1_000)),
          end_time: String(Math.ceil(input.triggerCreatedAtMs / 1_000)),
          sort_type: 'ByCreateTimeDesc',
          page_size: PAGE_SIZE,
          ...(pageToken ? { page_token: pageToken } : {}),
          card_msg_content_type: 'user_card_content',
        },
      });
      if (response.code !== undefined && response.code !== 0) {
        throw new Error(`history API code ${response.code}: ${response.msg ?? 'unknown error'}`);
      }
      const items = (response.data?.items ?? []) as RawMessageItem[];
      rawItems.push(...items);
      hasMore = response.data?.has_more === true;
      pageToken = response.data?.page_token;
      const oldestPageTime = Math.min(
        ...items.map((item) => parseFeishuTime(item.create_time) ?? Number.POSITIVE_INFINITY),
      );
      if (oldestPageTime <= oldestAllowedMs) {
        hasMore = false;
        break;
      }
      if (!hasMore || !pageToken) break;
    } catch (error) {
      degradedReason = classifyHistoryError(error);
      break;
    }
  }

  if (degradedReason && rawItems.length === 0) return degraded(input, degradedReason);

  const excluded = new Set(input.excludedMessageIds ?? []);
  for (const id of input.triggerMessageIds) excluded.add(id);
  const normalized = new Map<string, GroupContextMessage>();
  for (const raw of rawItems) {
    const message = normalizeGroupContextMessage(raw);
    if (!message || normalized.has(message.messageId)) continue;
    if (excluded.has(message.messageId)) continue;
    if (message.createdAtMs >= input.triggerCreatedAtMs) continue;
    if (message.createdAtMs < oldestAllowedMs) continue;
    if (input.chatMode === 'topic' && raw.thread_id !== input.threadId) continue;
    if (input.chatMode === 'group' && raw.chat_id !== input.chatId) continue;
    if (input.botOpenId && message.senderId === input.botOpenId) continue;
    if (!isAfterCursor(message, input.cursor)) continue;
    normalized.set(message.messageId, message);
  }

  const bounded = boundGroupContextMessages(
    [...normalized.values()],
    input.maxMessages ?? MAX_GROUP_CONTEXT_MESSAGES,
    input.maxChars ?? MAX_GROUP_CONTEXT_CHARS,
  );
  const truncated = bounded.truncated || hasMore;
  const status: GroupContextStatus = degradedReason
    ? 'degraded'
    : truncated
      ? 'truncated'
      : 'full';
  const cursorCandidate: GroupContextCursor = {
    lastCreatedAtMs: input.triggerCreatedAtMs,
    messageIdsAtLastCreatedAt: [...new Set(input.triggerMessageIds)].sort(),
  };
  return {
    chatId: input.chatId,
    chatMode: input.chatMode,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    status,
    truncated,
    ...(degradedReason ? { degradedReason } : {}),
    messages: bounded.messages,
    messageCount: bounded.messages.length,
    charCount: bounded.charCount,
    cursorCandidate,
  };
}

export function normalizeGroupContextMessage(
  raw: RawMessageItem,
): GroupContextMessage | undefined {
  const messageId = nonEmpty(raw.message_id);
  const createdAtMs = parseFeishuTime(raw.create_time);
  const senderId = nonEmpty(raw.sender?.id);
  if (!messageId || createdAtMs === undefined || !senderId) return undefined;
  const rawContentType = nonEmpty(raw.msg_type) ?? 'unknown';
  const parsed = parseMessageContent(rawContentType, raw.body?.content ?? '', raw.mentions ?? []);
  return {
    messageId,
    createdAt: new Date(createdAtMs).toISOString(),
    createdAtMs,
    senderId,
    senderName: nonEmpty(raw.sender?.sender_name) ?? senderId,
    senderType: raw.sender?.sender_type === 'app' || raw.sender?.sender_type === 'bot' ? 'bot' : 'user',
    rawContentType,
    content: parsed.content,
    ...(parsed.attachments.length > 0 ? { attachments: parsed.attachments } : {}),
  };
}

export function boundGroupContextMessages(
  messages: GroupContextMessage[],
  maxMessages = MAX_GROUP_CONTEXT_MESSAGES,
  maxChars = MAX_GROUP_CONTEXT_CHARS,
): { messages: GroupContextMessage[]; charCount: number; truncated: boolean } {
  const newestFirst = [...messages].sort(
    (a, b) => b.createdAtMs - a.createdAtMs || b.messageId.localeCompare(a.messageId),
  );
  const selected: GroupContextMessage[] = [];
  let charCount = 0;
  let truncated = newestFirst.length > maxMessages;
  for (const message of newestFirst.slice(0, maxMessages)) {
    const remaining = maxChars - charCount;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (message.content.length > remaining) {
      selected.push({ ...message, content: message.content.slice(0, remaining) });
      charCount += remaining;
      truncated = true;
      break;
    }
    selected.push(message);
    charCount += message.content.length;
  }
  selected.sort((a, b) => a.createdAtMs - b.createdAtMs || a.messageId.localeCompare(b.messageId));
  return { messages: selected, charCount, truncated };
}

function degraded(input: FetchGroupContextInput, reason: string): GroupContextResult {
  return {
    chatId: input.chatId,
    chatMode: input.chatMode,
    ...(input.threadId ? { threadId: input.threadId } : {}),
    status: 'degraded',
    truncated: false,
    degradedReason: reason,
    messages: [],
    messageCount: 0,
    charCount: 0,
    cursorCandidate: {
      lastCreatedAtMs: input.triggerCreatedAtMs,
      messageIdsAtLastCreatedAt: [...new Set(input.triggerMessageIds)].sort(),
    },
  };
}

function isAfterCursor(message: GroupContextMessage, cursor: GroupContextCursor | undefined): boolean {
  if (!cursor) return true;
  if (message.createdAtMs > cursor.lastCreatedAtMs) return true;
  if (message.createdAtMs < cursor.lastCreatedAtMs) return false;
  return !cursor.messageIdsAtLastCreatedAt.includes(message.messageId);
}

function parseMessageContent(
  type: string,
  rawContent: string,
  mentions: Array<{ key?: string; name?: string }>,
): { content: string; attachments: GroupContextAttachment[] } {
  const parsed = parseJson(rawContent);
  const attachments: GroupContextAttachment[] = [];
  let content = '';
  if (type === 'text') {
    content = stringField(parsed, 'text') ?? rawContent;
  } else if (type === 'post') {
    content = collectText(parsed).join('\n');
  } else if (type === 'file' || type === 'audio' || type === 'video' || type === 'image' || type === 'sticker') {
    const fileName = stringField(parsed, 'file_name') ?? stringField(parsed, 'fileName');
    attachments.push({ type, ...(fileName ? { fileName } : {}) });
    content = fileName ? `[${type}: ${fileName}]` : `[${type}]`;
  } else if (type === 'interactive') {
    content = '[interactive card]';
  } else {
    content = collectText(parsed).join('\n') || `[${type}]`;
  }
  for (const mention of mentions) {
    if (mention.key && mention.name) content = content.split(mention.key).join(`@${mention.name}`);
  }
  return { content: content.trim(), attachments };
}

function collectText(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    if (value.trim()) out.push(value.trim());
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, out);
    return out;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (/key|token|id$/i.test(key)) continue;
      collectText(item, out);
    }
  }
  return out;
}

function parseJson(input: string): unknown {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return input;
  }
}

function stringField(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const item = (value as Record<string, unknown>)[key];
  return typeof item === 'string' ? item : undefined;
}

function parseFeishuTime(input: unknown): number | undefined {
  if (typeof input !== 'string' && typeof input !== 'number') return undefined;
  const value = Number(input);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? Math.round(value * 1_000) : Math.round(value);
}

function nonEmpty(input: unknown): string | undefined {
  return typeof input === 'string' && input.trim() ? input : undefined;
}

function classifyHistoryError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/permission|forbidden|999916|2300/i.test(message)) return 'permission-denied';
  if (/timeout|timed out|abort/i.test(message)) return 'timeout';
  if (/page|pagination/i.test(message)) return 'pagination-failed';
  return 'api-error';
}
