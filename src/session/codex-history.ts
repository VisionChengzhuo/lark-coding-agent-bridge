import { normalizeSessionPreview } from './preview';

export type CodexThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'unknown';

export interface CodexThreadHistoryEntry {
  threadId: string;
  sessionId?: string;
  preview: string;
  cwd: string;
  createdAtMs: number;
  updatedAtMs: number;
  source: string;
  name?: string;
}

export interface ListCodexThreadHistoryOptions {
  cwd: string;
  limit: number;
  timeoutMs?: number;
  sourceKinds?: readonly CodexThreadSourceKind[];
  useStateDbOnly?: boolean;
}

export interface CodexHistoryRequester {
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
}

export type CodexHistoryErrorCode =
  | 'timeout'
  | 'app-server-error'
  | 'malformed-response';

export class CodexHistoryError extends Error {
  readonly code: CodexHistoryErrorCode;

  constructor(code: CodexHistoryErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'CodexHistoryError';
    this.code = code;
  }
}

const DEFAULT_HISTORY_TIMEOUT_MS = 5_000;
const DEFAULT_SOURCE_KINDS: readonly CodexThreadSourceKind[] = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'unknown',
];

export async function listCodexThreadHistory(
  options: ListCodexThreadHistoryOptions,
  requester: CodexHistoryRequester,
): Promise<CodexThreadHistoryEntry[]> {
  let response: unknown;
  try {
    response = await requester.request(
      'thread/list',
      {
        limit: options.limit,
        sortKey: 'updated_at',
        sortDirection: 'desc',
        archived: false,
        cwd: options.cwd,
        useStateDbOnly: options.useStateDbOnly ?? true,
        sourceKinds: [...(options.sourceKinds ?? DEFAULT_SOURCE_KINDS)],
      },
      options.timeoutMs ?? DEFAULT_HISTORY_TIMEOUT_MS,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CodexHistoryError(
      /timed out/i.test(message) ? 'timeout' : 'app-server-error',
      message,
      { cause: error },
    );
  }

  const parsed = parseThreadListResponse(response);
  if (!parsed.ok) throw parsed.error;
  return parsed.entries;
}

export function parseThreadListResponse(
  input: unknown,
): { ok: true; entries: CodexThreadHistoryEntry[] } | { ok: false; error: CodexHistoryError } {
  const raw = recordValue(input);
  if (!raw || !Array.isArray(raw.data)) {
    return {
      ok: false,
      error: new CodexHistoryError(
        'malformed-response',
        'codex app-server returned malformed thread/list response',
      ),
    };
  }
  return {
    ok: true,
    entries: raw.data
      .map(normalizeThread)
      .filter((entry): entry is CodexThreadHistoryEntry => Boolean(entry)),
  };
}

function normalizeThread(input: unknown): CodexThreadHistoryEntry | undefined {
  const raw = recordValue(input);
  if (!raw) return undefined;
  const threadId = stringValue(raw.id);
  const cwd = stringValue(raw.cwd);
  if (!threadId || !cwd) return undefined;
  const createdAt = numberValue(raw.createdAt);
  const updatedAt = numberValue(raw.updatedAt);
  const sessionId = stringValue(raw.sessionId);
  const name = stringValue(raw.name);
  return {
    threadId,
    ...(sessionId ? { sessionId } : {}),
    preview: normalizeSessionPreview(stringValue(raw.preview) ?? '') || '(空会话)',
    cwd,
    createdAtMs: Math.round((createdAt ?? 0) * 1_000),
    updatedAtMs: Math.round((updatedAt ?? 0) * 1_000),
    source: sourceValue(raw.source),
    ...(name ? { name } : {}),
  };
}

function sourceValue(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return JSON.stringify(input);
  return 'unknown';
}

function stringValue(input: unknown): string | undefined {
  return typeof input === 'string' ? input : undefined;
}

function numberValue(input: unknown): number | undefined {
  return typeof input === 'number' && Number.isFinite(input) ? input : undefined;
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}
