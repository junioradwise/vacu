import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { privateDirectory, requestLimit, responseLimit, socketPath } from './socket.mjs';

process.umask(0o077);
const pending = new Map();
const clients = new Set();
let input = Buffer.alloc(0);

function send(message) {
  const data = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(data.length);
  process.stdout.write(Buffer.concat([header, data]));
}

const server = createServer((client) => {
  if (clients.size >= 4) return client.destroy();
  clients.add(client);
  let buffer = Buffer.alloc(0);
  let id;
  client.setTimeout(18_000, () => client.destroy());
  client.on('error', () => client.destroy());
  client.on('close', () => {
    clients.delete(client);
    pending.delete(id);
  });
  client.on('data', (chunk) => {
    if (id || buffer.length + chunk.length > requestLimit) return client.destroy();
    buffer = Buffer.concat([buffer, chunk]);
    if (!buffer.includes(10)) return;
    try {
      const args = JSON.parse(buffer.toString('utf8'));
      if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('Invalid command');
      const index = args[0] === '--session' ? 2 : 0;
      const framedWait = args[index] === 'inspect-wait' && args[index + 1] === '--frame';
      if (args.length <= index || args.length > index + (framedWait ? 7 : 6)) throw new Error('Invalid command');
      id = randomUUID();
      pending.set(id, client);
      send({ id, args });
    } catch (error) {
      client.end(JSON.stringify({ error: error.message }) + '\n');
    }
  });
});

function shutdown() {
  for (const client of clients) client.destroy();
  server.close();
}

process.stdin.on('data', (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const size = input.readUInt32LE(0);
    if (size > responseLimit) return process.exit(1);
    if (input.length < size + 4) return;
    let message;
    try { message = JSON.parse(input.subarray(4, size + 4).toString('utf8')); }
    catch { return process.exit(1); }
    input = input.subarray(size + 4);
    const client = pending.get(message?.id);
    if (client) {
      pending.delete(message.id);
      client.end(JSON.stringify({ value: message.value, error: message.error }) + '\n');
    }
  }
});
process.stdin.on('end', shutdown);
process.stdout.on('error', () => process.exit(1));
process.on('SIGTERM', () => { process.stdin.pause(); shutdown(); });
process.on('SIGINT', () => { process.stdin.pause(); shutdown(); });

try {
  privateDirectory(true);
  server.maxConnections = 4;
  server.on('error', (error) => {
    send({ startupError: error.code === 'EADDRINUSE'
      ? 'Socket already in use. Stop other VACU bridges first; see README for stale sockets.'
      : error.message });
    process.stdin.pause();
  });
  server.listen(socketPath, () => send({ ready: true }));
} catch (error) {
  send({ startupError: error.message });
  process.stdin.pause();
}
