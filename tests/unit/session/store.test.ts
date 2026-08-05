import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../../../src/session/store.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: TmpProfile[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((tmp) => tmp.cleanup()));
});

describe('session scope preferences', () => {
  it('persists model and effort overrides and preserves them across session reset', async () => {
    const tmp = await createTmpProfile('session-scope-preferences-');
    cleanups.push(tmp);
    const path = join(tmp.profile, 'sessions.json');
    const store = new SessionStore(path);
    store.set('chat-1', 'thread-1', tmp.workspace);
    store.setModel('chat-1', 'gpt-5.6-terra');
    store.setReasoningEffort('chat-1', 'xhigh');
    store.clear('chat-1');
    await store.flush();

    const loaded = new SessionStore(path);
    await loaded.load();
    expect(loaded.getRaw('chat-1')).not.toHaveProperty('sessionId');
    expect(loaded.getModel('chat-1')).toBe('gpt-5.6-terra');
    expect(loaded.getReasoningEffort('chat-1')).toBe('xhigh');

    loaded.setModel('chat-1', undefined);
    loaded.setReasoningEffort('chat-1', undefined);
    await loaded.flush();
    const cleared = new SessionStore(path);
    await cleared.load();
    expect(cleared.getRaw('chat-1')).toBeUndefined();
  });
});
