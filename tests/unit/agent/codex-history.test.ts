import { describe, expect, it } from 'vitest';
import { buildAgentPrompt } from '../../../src/agent/prompt.js';
import {
  CodexHistoryError,
  listCodexThreadHistory,
  type CodexHistoryRequester,
} from '../../../src/session/codex-history.js';

describe('shared Codex thread history provider', () => {
  it('queries the shared client with cwd/source bounds and normalizes entries', async () => {
    const requests: Array<{ method: string; params: unknown; timeoutMs: number | undefined }> = [];
    const requester: CodexHistoryRequester = {
      request: async <T>(method: string, params?: unknown, timeoutMs?: number) => {
        requests.push({ method, params, timeoutMs });
        return {
          data: [
            {
              id: 'thread-new',
              sessionId: 'session-new',
              preview: 'new thread prompt',
              cwd: '/repo',
              createdAt: 1_700_000_000,
              updatedAt: 1_700_000_050,
              source: 'appServer',
              name: 'New work',
            },
            {
              id: 'thread-old',
              sessionId: 'session-old',
              preview: '',
              cwd: '/repo',
              createdAt: 1_699_999_000,
              updatedAt: 1_699_999_500,
              source: 'cli',
            },
          ],
          nextCursor: null,
        } as T;
      },
    };

    const entries = await listCodexThreadHistory(
      { cwd: '/repo', limit: 2, timeoutMs: 1_234 },
      requester,
    );

    expect(requests).toEqual([
      {
        method: 'thread/list',
        timeoutMs: 1_234,
        params: {
          cwd: '/repo',
          limit: 2,
          archived: false,
          sortKey: 'updated_at',
          sortDirection: 'desc',
          useStateDbOnly: true,
          sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
        },
      },
    ]);
    expect(entries).toEqual([
      {
        threadId: 'thread-new',
        sessionId: 'session-new',
        preview: 'new thread prompt',
        cwd: '/repo',
        createdAtMs: 1_700_000_000_000,
        updatedAtMs: 1_700_000_050_000,
        source: 'appServer',
        name: 'New work',
      },
      {
        threadId: 'thread-old',
        sessionId: 'session-old',
        preview: '(空会话)',
        cwd: '/repo',
        createdAtMs: 1_699_999_000_000,
        updatedAtMs: 1_699_999_500_000,
        source: 'cli',
      },
    ]);
  });

  it('uses only the request timeout and does not close or restart the shared client', async () => {
    let closeCalls = 0;
    const requester = {
      request: async <T>() => ({ data: [], nextCursor: null } as T),
      close: async () => {
        closeCalls++;
      },
    };

    await listCodexThreadHistory({ cwd: '/repo', limit: 5, timeoutMs: 25 }, requester);

    expect(closeCalls).toBe(0);
  });

  it('wraps request failures without affecting other client requests', async () => {
    let calls = 0;
    const requester: CodexHistoryRequester = {
      request: async <T>() => {
        calls++;
        if (calls === 1) throw new Error('history unavailable');
        return { data: [] } as T;
      },
    };

    await expect(
      listCodexThreadHistory({ cwd: '/repo', limit: 1 }, requester),
    ).rejects.toMatchObject({
      name: 'CodexHistoryError',
      code: 'app-server-error',
    } satisfies Partial<CodexHistoryError>);
    await expect(
      listCodexThreadHistory({ cwd: '/repo', limit: 1 }, requester),
    ).resolves.toEqual([]);
  });

  it('summarizes bridge-prefixed previews using the actual user input section', async () => {
    const preview = `# lark-channel-bridge 运行约定\n\n## user_message\n\n${buildAgentPrompt({
      context: {
        chatId: 'oc_secret',
        chatType: 'p2p',
        senderId: 'ou_secret',
        source: 'im',
      },
      instructions: ['internal bridge instruction'],
      userInput: 'Codex 真实用户问题\n\n第二行',
    })}`;
    const requester: CodexHistoryRequester = {
      request: async <T>() => ({
        data: [{
          id: 'thread-1', preview, cwd: '/repo', createdAt: 1, updatedAt: 2, source: 'exec',
        }],
      } as T),
    };

    const entries = await listCodexThreadHistory({ cwd: '/repo', limit: 1 }, requester);

    expect(entries[0]?.preview).toBe('Codex 真实用户问题 第二行');
  });
});
