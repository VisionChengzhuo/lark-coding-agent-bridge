const SAFE_CODEX_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

export function codexThreadDeepLink(threadId: string): string {
  if (!SAFE_CODEX_THREAD_ID.test(threadId)) {
    throw new Error('invalid Codex thread id');
  }
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export function tryCodexThreadDeepLink(threadId: string | undefined): string | undefined {
  if (!threadId) return undefined;
  try {
    return codexThreadDeepLink(threadId);
  } catch {
    return undefined;
  }
}

export interface CodexDesktopOpenCommand {
  command: string;
  args: string[];
}

export function codexDesktopOpenCommand(
  threadId: string,
  platform: NodeJS.Platform = process.platform,
): CodexDesktopOpenCommand {
  const url = codexThreadDeepLink(threadId);
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') {
    return { command: 'cmd.exe', args: ['/d', '/s', '/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}
