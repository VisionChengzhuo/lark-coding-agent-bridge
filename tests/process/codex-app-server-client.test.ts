import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CodexAppServerClient,
  type AppServerExit,
} from '../../src/agent/codex/app-server-client.js';
import type { SpawnedProcessByStdio } from '../../src/platform/spawn.js';
import type { Readable, Writable } from 'node:stream';

type TestChild = SpawnedProcessByStdio<Writable, Readable, Readable>;

const fixture = fileURLToPath(
  new URL('../fixtures/fake-codex-app-server.mjs', import.meta.url),
);
const clients: CodexAppServerClient[] = [];

function createClient(mode = 'normal'): CodexAppServerClient {
  const client = new CodexAppServerClient({
    binary: 'fake-codex',
    requestTimeoutMs: 500,
    initializeTimeoutMs: 500,
    shutdownGraceMs: 250,
    env: { FAKE_APP_SERVER_MODE: mode },
    spawn: (_binary, _args, env) =>
      spawn(process.execPath, [fixture], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      }) as TestChild,
  });
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
});

describe('CodexAppServerClient process contract', () => {
  it('blocks requests on initialize and sends initialized before application requests', async () => {
    const client = createClient();
    const state = await client.request<{ received: string[]; pid: number }>('fake/state', {});

    expect(state.received.slice(0, 3)).toEqual(['initialize', 'initialized', 'fake/state']);
    expect(state.pid).toBe(client.pid());
  });

  it('uses unique request ids and correlates out-of-order responses', async () => {
    const client = createClient();
    const slow = client.request<string>('fake/echo', { value: 'slow', delayMs: 30 });
    const fast = client.request<string>('fake/echo', { value: 'fast', delayMs: 1 });

    await expect(fast).resolves.toBe('fast');
    await expect(slow).resolves.toBe('slow');
  });

  it('times out only the affected request and keeps the same server reusable', async () => {
    const client = createClient();
    await client.ensureStarted();
    const pid = client.pid();

    await expect(client.request('fake/never', {}, 20)).rejects.toThrow('timed out');
    await expect(client.request('fake/echo', { value: 'still-alive' })).resolves.toBe(
      'still-alive',
    );
    expect(client.pid()).toBe(pid);
  });

  it('parses split stdout, ignores blank/non-json lines, and dispatches notifications', async () => {
    const client = createClient();
    const notifications: string[] = [];
    client.onNotification((notification) => notifications.push(notification.method));

    await client.ensureStarted();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(notifications).toContain('fake/chunked');
    await expect(client.request('fake/echo', { value: 'ok' })).resolves.toBe('ok');
  });

  it('rejects pending requests on crash and starts one fresh server for the next request', async () => {
    const client = createClient();
    const exits: AppServerExit[] = [];
    client.onExit((exit) => exits.push(exit));
    await client.ensureStarted();
    const oldPid = client.pid();

    const pending = client.request('fake/never', {}, 2_000);
    void client.request('fake/crash', {}).catch(() => {});
    await expect(pending).rejects.toThrow('exited with code 17');
    expect(exits).toHaveLength(1);
    expect(exits[0]?.expected).toBe(false);

    await expect(client.request('fake/echo', { value: 'recovered' })).resolves.toBe('recovered');
    expect(client.pid()).toBeDefined();
    expect(client.pid()).not.toBe(oldPid);
  });

  it('closes the shared child without leaving it alive', async () => {
    const client = createClient();
    await client.ensureStarted();
    const pid = client.pid();
    expect(pid).toBeDefined();

    await client.close();

    expect(processIsAlive(pid!)).toBe(false);
  });

  it('fails clearly when initialization is rejected', async () => {
    const client = createClient('initialize-error');

    await expect(client.ensureStarted()).rejects.toThrow(
      'initialization failed: codex app-server rejected initialize: initialization rejected',
    );
  });

  it('rejects initialization when the server exits before responding', async () => {
    const client = createClient('exit-before-initialize');

    await expect(client.ensureStarted()).rejects.toThrow('exited with code 23');
  });

  it('reports a spawn failure for a missing binary', async () => {
    const client = new CodexAppServerClient({
      binary: `/missing/fake-codex-${process.pid}`,
      initializeTimeoutMs: 100,
    });
    clients.push(client);

    await expect(client.ensureStarted()).rejects.toThrow('spawn returned no pid');
  });
});

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
