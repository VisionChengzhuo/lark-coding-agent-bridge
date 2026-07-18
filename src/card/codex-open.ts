import type { ChildProcess } from 'node:child_process';
import { spawnProcess } from '../platform/spawn';
import { codexDesktopOpenCommand } from './codex-link';

export type CodexDesktopSpawner = (
  command: string,
  args: readonly string[],
) => ChildProcess;

export async function openCodexThreadOnDesktop(
  threadId: string,
  spawn: CodexDesktopSpawner = (command, args) =>
    spawnProcess(command, args, { stdio: 'ignore' }),
): Promise<void> {
  const target = codexDesktopOpenCommand(threadId);
  const child = spawn(target.command, target.args);
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onSpawn = (): void => finish();
    const onError = (error: Error): void => finish(error);
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
  child.unref();
}
