import { readFile } from 'node:fs/promises';
import { log } from '../core/logger';
import { writeFileAtomic } from '../platform/atomic-write';
import type { GroupContextCursor, GroupContextStatus } from '../bot/group-context';

export interface GroupContextDiagnostic {
  status: GroupContextStatus;
  messageCount: number;
  charCount: number;
  reason?: string;
  updatedAt: number;
}

interface CursorEntry {
  profile: string;
  scope: string;
  threadId: string;
  cursor: GroupContextCursor;
  diagnostic: GroupContextDiagnostic;
}

interface PersistedState {
  version: 1;
  entries: CursorEntry[];
  diagnostics: Array<{ profile: string; scope: string; diagnostic: GroupContextDiagnostic }>;
}

const SEPARATOR = '\u001f';

export class GroupContextCursorStore {
  private readonly entries = new Map<string, CursorEntry>();
  private readonly diagnostics = new Map<string, GroupContextDiagnostic>();
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.path, 'utf8')) as Partial<PersistedState>;
      this.entries.clear();
      this.diagnostics.clear();
      for (const entry of raw.entries ?? []) {
        if (!validEntry(entry)) continue;
        this.entries.set(cursorKey(entry.profile, entry.scope, entry.threadId), entry);
      }
      for (const item of raw.diagnostics ?? []) {
        if (!item || typeof item.profile !== 'string' || typeof item.scope !== 'string' || !validDiagnostic(item.diagnostic)) continue;
        this.diagnostics.set(scopeKey(item.profile, item.scope), item.diagnostic);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      log.fail('context-cursor', error, { step: 'load' });
    }
  }

  cursorFor(profile: string, scope: string, threadId: string | undefined): GroupContextCursor | undefined {
    if (!threadId) return undefined;
    const entry = this.entries.get(cursorKey(profile, scope, threadId));
    return entry ? { ...entry.cursor, messageIdsAtLastCreatedAt: [...entry.cursor.messageIdsAtLastCreatedAt] } : undefined;
  }

  recordDiagnostic(profile: string, scope: string, diagnostic: GroupContextDiagnostic): void {
    this.diagnostics.set(scopeKey(profile, scope), { ...diagnostic });
    this.schedulePersist();
  }

  diagnosticFor(profile: string, scope: string): GroupContextDiagnostic | undefined {
    const diagnostic = this.diagnostics.get(scopeKey(profile, scope));
    return diagnostic ? { ...diagnostic } : undefined;
  }

  commit(input: {
    profile: string;
    scope: string;
    threadId: string;
    cursor: GroupContextCursor;
    diagnostic: GroupContextDiagnostic;
  }): void {
    if (input.diagnostic.status === 'degraded') return;
    const entry: CursorEntry = {
      profile: input.profile,
      scope: input.scope,
      threadId: input.threadId,
      cursor: {
        ...input.cursor,
        messageIdsAtLastCreatedAt: [...input.cursor.messageIdsAtLastCreatedAt],
      },
      diagnostic: { ...input.diagnostic },
    };
    this.entries.set(cursorKey(input.profile, input.scope, input.threadId), entry);
    this.diagnostics.set(scopeKey(input.profile, input.scope), { ...input.diagnostic });
    this.schedulePersist();
  }

  async flush(): Promise<void> {
    await this.saving;
  }

  private schedulePersist(): void {
    this.saving = this.saving
      .then(() => this.persist())
      .catch((error: unknown) => log.fail('context-cursor', error, { step: 'persist' }));
  }

  private async persist(): Promise<void> {
    const state: PersistedState = {
      version: 1,
      entries: [...this.entries.values()],
      diagnostics: [...this.diagnostics.entries()].map(([key, diagnostic]) => {
        const [profile = '', scope = ''] = key.split(SEPARATOR);
        return { profile, scope, diagnostic };
      }),
    };
    await writeFileAtomic(this.path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  }
}

function cursorKey(profile: string, scope: string, threadId: string): string {
  return [profile, scope, threadId].join(SEPARATOR);
}

function scopeKey(profile: string, scope: string): string {
  return [profile, scope].join(SEPARATOR);
}

function validEntry(input: unknown): input is CursorEntry {
  if (!input || typeof input !== 'object') return false;
  const entry = input as Partial<CursorEntry>;
  return (
    typeof entry.profile === 'string' &&
    typeof entry.scope === 'string' &&
    typeof entry.threadId === 'string' &&
    validCursor(entry.cursor) &&
    validDiagnostic(entry.diagnostic)
  );
}

function validCursor(input: unknown): input is GroupContextCursor {
  if (!input || typeof input !== 'object') return false;
  const cursor = input as Partial<GroupContextCursor>;
  return (
    typeof cursor.lastCreatedAtMs === 'number' &&
    Array.isArray(cursor.messageIdsAtLastCreatedAt) &&
    cursor.messageIdsAtLastCreatedAt.every((id) => typeof id === 'string')
  );
}

function validDiagnostic(input: unknown): input is GroupContextDiagnostic {
  if (!input || typeof input !== 'object') return false;
  const diagnostic = input as Partial<GroupContextDiagnostic>;
  return (
    (diagnostic.status === 'full' || diagnostic.status === 'truncated' || diagnostic.status === 'degraded') &&
    typeof diagnostic.messageCount === 'number' &&
    typeof diagnostic.charCount === 'number' &&
    typeof diagnostic.updatedAt === 'number'
  );
}
