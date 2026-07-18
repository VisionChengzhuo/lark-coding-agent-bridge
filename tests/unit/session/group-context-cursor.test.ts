import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GroupContextCursorStore } from '../../../src/session/group-context-cursor.js';
import { createTmpProfile } from '../../helpers/tmp-profile.js';

describe('GroupContextCursorStore', () => {
  it('persists cursors by profile + scope + Codex thread and restores after restart', async () => {
    const tmp = await createTmpProfile('group-cursor-');
    const path = join(tmp.profile, 'group-context.json');
    const store = new GroupContextCursorStore(path);
    store.commit({
      profile: 'codex', scope: 'oc:omt_a', threadId: 'thread-a',
      cursor: { lastCreatedAtMs: 100, messageIdsAtLastCreatedAt: ['om_a'] },
      diagnostic: { status: 'full', messageCount: 2, charCount: 20, updatedAt: 100 },
    });
    store.commit({
      profile: 'codex', scope: 'oc:omt_b', threadId: 'thread-b',
      cursor: { lastCreatedAtMs: 200, messageIdsAtLastCreatedAt: ['om_b'] },
      diagnostic: { status: 'truncated', messageCount: 30, charCount: 24_000, updatedAt: 200 },
    });
    await store.flush();

    const restored = new GroupContextCursorStore(path);
    await restored.load();

    expect(restored.cursorFor('codex', 'oc:omt_a', 'thread-a')).toEqual({
      lastCreatedAtMs: 100, messageIdsAtLastCreatedAt: ['om_a'],
    });
    expect(restored.cursorFor('codex', 'oc:omt_a', 'thread-b')).toBeUndefined();
    expect(restored.diagnosticFor('codex', 'oc:omt_b')).toMatchObject({ status: 'truncated' });
    await tmp.cleanup();
  });

  it('does not advance a cursor for degraded history attempts', async () => {
    const tmp = await createTmpProfile('group-cursor-degraded-');
    const store = new GroupContextCursorStore(join(tmp.profile, 'group-context.json'));

    store.commit({
      profile: 'codex', scope: 'oc', threadId: 'thread-a',
      cursor: { lastCreatedAtMs: 100, messageIdsAtLastCreatedAt: ['old'] },
      diagnostic: { status: 'full', messageCount: 1, charCount: 3, updatedAt: 100 },
    });
    store.commit({
      profile: 'codex', scope: 'oc', threadId: 'thread-a',
      cursor: { lastCreatedAtMs: 200, messageIdsAtLastCreatedAt: ['lost'] },
      diagnostic: { status: 'degraded', messageCount: 0, charCount: 0, reason: 'timeout', updatedAt: 200 },
    });

    expect(store.cursorFor('codex', 'oc', 'thread-a')).toEqual({
      lastCreatedAtMs: 100, messageIdsAtLastCreatedAt: ['old'],
    });
    await store.flush();
    await tmp.cleanup();
  });
});
