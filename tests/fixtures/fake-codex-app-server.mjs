import { createInterface } from 'node:readline';

const received = [];
const mode = process.env.FAKE_APP_SERVER_MODE ?? 'normal';
let initialized = false;

const send = (message) => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  received.push(message.method);

  if (message.method === 'initialize') {
    if (mode === 'exit-before-initialize') {
      process.exit(23);
      return;
    }
    if (mode === 'initialize-error') {
      send({ id: message.id, error: { code: -32000, message: 'initialization rejected' } });
      return;
    }
    send({ id: message.id, result: { userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'test' } });
    return;
  }
  if (message.method === 'initialized') {
    initialized = true;
    process.stdout.write('\nnot-json\n');
    const notification = `${JSON.stringify({ method: 'fake/chunked', params: { ok: true } })}\n`;
    const midpoint = Math.floor(notification.length / 2);
    process.stdout.write(notification.slice(0, midpoint));
    process.stdout.write(notification.slice(midpoint));
    process.stderr.write('fake stderr token=secret-for-redaction\n');
    return;
  }

  if (!initialized) {
    send({ id: message.id, error: { code: -32002, message: 'not initialized' } });
    return;
  }
  if (message.method === 'fake/state') {
    send({ id: message.id, result: { received, pid: process.pid } });
    return;
  }
  if (message.method === 'fake/echo') {
    const delayMs = Number(message.params?.delayMs ?? 0);
    setTimeout(() => send({ id: message.id, result: message.params?.value }), delayMs);
    return;
  }
  if (message.method === 'fake/never') return;
  if (message.method === 'fake/crash') {
    setTimeout(() => process.exit(17), 5);
    return;
  }
  send({ id: message.id, error: { code: -32601, message: `unknown method ${message.method}` } });
});

process.stdin.on('end', () => process.exit(0));
