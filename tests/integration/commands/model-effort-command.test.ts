import { join } from 'node:path';
import type { NormalizedMessage } from '@larksuite/channel';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentModelOption } from '../../../src/agent/types.js';
import { ActiveRuns } from '../../../src/bot/active-runs.js';
import { tryHandleCommand, type CommandContext, type Controls } from '../../../src/commands/index.js';
import { createDefaultProfileConfig } from '../../../src/config/profile-schema.js';
import { SessionStore } from '../../../src/session/store.js';
import { WorkspaceStore } from '../../../src/workspace/store.js';
import { FakeAgentAdapter } from '../../helpers/fake-agent.js';
import { createFakeChannel } from '../../helpers/fake-channel.js';
import { createTmpProfile, type TmpProfile } from '../../helpers/tmp-profile.js';

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe('Codex model commands', () => {
  it('lists live options when invoked from the native dropdown menu', async () => {
    const h = await createHarness();

    await expect(h.command('/model')).resolves.toBe(true);
    expect(h.lastMarkdown()).toContain('gpt-5.6-terra');
    expect(h.lastMarkdown()).toContain('/model <模型值>');

    await expect(h.command('/effort')).resolves.toBe(true);
    expect(h.lastMarkdown()).toContain('ultra');
    expect(h.lastMarkdown()).toContain('/effort <强度值>');
  });

  it('persists valid model and effort arguments for the current DM', async () => {
    const h = await createHarness();

    await h.command('/model gpt-5.6-terra');
    await h.command('/effort ultra');

    expect(h.sessions.getModel('oc_dm')).toBe('gpt-5.6-terra');
    expect(h.sessions.getReasoningEffort('oc_dm')).toBe('ultra');
    expect(h.lastMarkdown()).toContain('Ultra（自动委派）');

    await h.command('/model default');
    await h.command('/effort default');
    expect(h.sessions.getModel('oc_dm')).toBeUndefined();
    expect(h.sessions.getReasoningEffort('oc_dm')).toBeUndefined();
  });

  it('rejects unknown values and clears an effort unsupported by a new model', async () => {
    const h = await createHarness();

    await h.command('/model missing-model');
    expect(h.sessions.getModel('oc_dm')).toBeUndefined();

    await h.command('/model gpt-5.6-terra');
    await h.command('/effort ultra');
    await h.command('/model gpt-limited');
    expect(h.sessions.getModel('oc_dm')).toBe('gpt-limited');
    expect(h.sessions.getReasoningEffort('oc_dm')).toBeUndefined();
    expect(h.lastMarkdown()).toContain('已恢复跟随模型默认');
  });
});

describe('Claude model commands', () => {
  it('maps the native /model fable menu entry to the complete provider model id', async () => {
    const h = await createHarness('claude');

    await h.command('/model fable');

    expect(h.sessions.getModel('oc_dm')).toBe('pa/claude-fable-5');
    expect(h.lastMarkdown()).toContain('Fable 5（默认）');
  });
});

async function createHarness(agentKind: 'codex' | 'claude' = 'codex'): Promise<{
  tmp: TmpProfile;
  channel: ReturnType<typeof createFakeChannel>;
  sessions: SessionStore;
  command(content: string): Promise<boolean>;
  lastMarkdown(): string;
}> {
  const tmp = await createTmpProfile('model-effort-command-');
  const channel = createFakeChannel();
  const sessions = new SessionStore(join(tmp.profile, 'sessions.json'));
  const workspaces = new WorkspaceStore(join(tmp.profile, 'workspaces.json'));
  const activeRuns = new ActiveRuns();
  const profileConfig = createDefaultProfileConfig({
    agentKind,
    accounts: { app: { id: 'app-id', secret: 'secret', tenant: 'feishu' } },
    codex: { binaryPath: 'codex' },
  });
  const agent = new FakeAgentAdapter({
    id: 'codex',
    displayName: 'Codex App Server',
    models: TEST_MODELS,
  });
  const controls = {
    profile: 'codex',
    profileConfig,
    botOwnerId: 'ou-user',
    ownerRefreshState: 'ok',
    async refreshOwner() {},
    async restart() {},
    async exit() {},
    configPath: join(tmp.profile, 'config.json'),
    cfg: profileConfig,
    processId: 'proc-1',
  } satisfies Controls;
  let nextUserMessage = 1;

  cleanups.push(async () => {
    await Promise.all([sessions.flush(), workspaces.flush()]);
    await tmp.cleanup();
  });

  return {
    tmp,
    channel,
    sessions,
    command: (content) =>
      tryHandleCommand({
        channel: channel as unknown as CommandContext['channel'],
        msg: message(content, `om_user_${nextUserMessage++}`),
        scope: 'oc_dm',
        chatMode: 'p2p',
        sessions,
        workspaces,
        agent,
        activeRuns,
        controls,
      }),
    lastMarkdown: () => {
      const content = channel.sent.at(-1)?.content as { markdown?: string } | undefined;
      return content?.markdown ?? '';
    },
  };
}

const TEST_MODELS: AgentModelOption[] = [
  {
    value: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    description: 'Frontier model',
    isDefault: true,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [
      { value: 'low', description: 'Fast' },
      { value: 'ultra', description: 'Delegates automatically' },
    ],
  },
  {
    value: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    description: 'Balanced model',
    isDefault: false,
    defaultReasoningEffort: 'medium',
    supportedReasoningEfforts: [
      { value: 'low', description: 'Fast' },
      { value: 'medium', description: 'Balanced' },
      { value: 'ultra', description: 'Delegates automatically' },
    ],
  },
  {
    value: 'gpt-limited',
    label: 'GPT Limited',
    description: 'Limited reasoning options',
    isDefault: false,
    defaultReasoningEffort: 'low',
    supportedReasoningEfforts: [{ value: 'low', description: 'Fast' }],
  },
];

function message(content: string, messageId: string): NormalizedMessage {
  return {
    messageId,
    chatId: 'oc_dm',
    chatType: 'p2p',
    senderId: 'ou-user',
    senderName: 'User',
    content,
    resources: [],
    mentions: [],
    mentionedBot: false,
  } as unknown as NormalizedMessage;
}
