import { describe, expect, it } from 'vitest';
import {
  codexDesktopOpenCommand,
  codexThreadDeepLink,
} from '../../../src/card/codex-link.js';
import { renderCard } from '../../../src/card/run-renderer.js';
import { initialState, type RunState } from '../../../src/card/run-state.js';
import { resumeCard, statusCard } from '../../../src/card/templates.js';

describe('Codex thread deep links', () => {
  it('generates the exact encoded codex:// URL for a valid App Server thread id', () => {
    expect(codexThreadDeepLink('019f7421-dc82-7cd0-b63d-c019cb27e7ba')).toBe(
      'codex://threads/019f7421-dc82-7cd0-b63d-c019cb27e7ba',
    );
  });

  it('builds desktop opener argv without a shell-composed URL', () => {
    expect(codexDesktopOpenCommand('thread-1', 'darwin')).toEqual({
      command: 'open',
      args: ['codex://threads/thread-1'],
    });
    expect(codexDesktopOpenCommand('thread-1', 'linux')).toEqual({
      command: 'xdg-open',
      args: ['codex://threads/thread-1'],
    });
  });

  it.each(['', ' has-space', 'line\nbreak', 'quote"id', '../escape', 'codex://threads/x']) (
    'rejects unsafe or non-thread identifiers: %j',
    (threadId) => {
      expect(() => codexThreadDeepLink(threadId)).toThrow('invalid Codex thread id');
    },
  );

  it('shows a status link only for a valid Codex session', () => {
    const linked = statusCard(statusInfo({
      sessionId: 'thread-1', codexThreadId: 'thread-1', agentName: 'Codex App Server',
    }), { signCodexOpen: () => 'opaque-status-token' });
    const absent = statusCard(statusInfo({ sessionId: undefined, codexThreadId: undefined }));
    const claude = statusCard(statusInfo({ sessionId: 'claude-session', agentName: 'Claude' }));

    expect(findOpenTokens(linked)).toEqual(['opaque-status-token']);
    expect(JSON.stringify(linked)).not.toContain('thread-1","');
    expect(findUrls(absent)).toEqual([]);
    expect(findUrls(claude)).toEqual([]);
  });

  it('adds open buttons to Codex resume entries without replacing resume callbacks', () => {
    const card = resumeCard('/repo', [
      {
        sessionId: 'nonce-1',
        codexThreadId: 'thread-1',
        preview: 'Codex work',
        relTime: 'now',
      },
      {
        sessionId: 'claude-session',
        preview: 'Claude work',
        relTime: 'now',
      },
    ], { signCodexOpen: () => 'opaque-resume-token' });

    expect(findOpenTokens(card)).toEqual(['opaque-resume-token']);
    expect(JSON.stringify(card)).toContain('resume.use');
    expect(JSON.stringify(card)).toContain('nonce-1');
    expect(JSON.stringify(card)).not.toContain('codex://threads/thread-1');
  });

  it.each(['running', 'done', 'error', 'interrupted'] as const)(
    'uses the same thread id on %s run cards and keeps stop callback separate',
    (terminal) => {
      const state: RunState = {
        ...initialState,
        threadId: 'thread-1',
        terminal,
        footer: terminal === 'running' ? 'thinking' : null,
        ...(terminal === 'error' ? { errorMsg: 'failed' } : {}),
      };
      const card = renderCard(state, {
        signCallback: () => 'signed-stop-token',
        signCodexOpen: () => 'opaque-open-token',
      });
      const text = JSON.stringify(card);

      expect(findOpenTokens(card)).toEqual(['opaque-open-token']);
      expect(text).not.toContain('threadId');
      if (terminal === 'running') {
        expect(text).toContain('signed-stop-token');
      }
      const openBehavior = findObjects(card).find(
        (value) => value.type === 'callback' && findObjects(value).some((item) => item.cmd === 'codex.open'),
      );
      expect(openBehavior).toBeDefined();
    },
  );
});

function statusInfo(overrides: Record<string, unknown> = {}) {
  return {
    profileName: 'codex',
    cwd: '/repo',
    sessionStale: false,
    agentName: 'Codex App Server',
    runtimeAccess: { label: 'sandbox', value: 'read-only/read-only' },
    activeRun: false,
    ownerState: 'ready',
    scope: 'oc_chat',
    chatMode: 'p2p' as const,
    ...overrides,
  };
}

function findUrls(value: unknown): string[] {
  return findObjects(value)
    .flatMap((item) => [item.url, item.default_url])
    .filter((item): item is string => typeof item === 'string');
}

function findOpenTokens(value: unknown): string[] {
  return findObjects(value)
    .filter((item) => item.cmd === 'codex.open')
    .map((item) => item.bridge_token)
    .filter((item): item is string => typeof item === 'string');
}

function findObjects(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) return value.flatMap(findObjects);
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  return [record, ...Object.values(record).flatMap(findObjects)];
}
