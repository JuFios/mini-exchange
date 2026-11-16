import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createConnection, createServer, Socket } from 'node:net';
import { test } from 'node:test';
import { holdSlowBodies, startFlood } from './ingress-client-limits';

test('retains every socket for cleanup after a partial connection failure', async () => {
  const server = createServer((socket) => socket.on('error', () => undefined));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const sockets: Socket[] = [];
  let attempt = 0;
  try {
    await assert.rejects(
      holdSlowBodies(
        '127.0.0.1',
        sockets,
        () => {
          const socket = createConnection({ host: '127.0.0.1', port });
          if (++attempt === 2)
            queueMicrotask(() => socket.destroy(new Error('partial connect failure')));
          return socket;
        },
        2,
      ),
      /partial connect failure/,
    );
    assert.equal(sockets.length, 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  assert(sockets.every((socket) => socket.destroyed));
});

test('kills a child that reports counts but never exits within the stop deadline', async () => {
  const child = spawn(
    process.execPath,
    ['-e', `process.send('ready'); process.on('message',()=>process.send({200:1}));`],
    {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const closed = once(child, 'close');
  const flood = startFlood('config', '127.0.0.1', 'unused', child);
  try {
    await flood.ready;
    await assert.rejects(flood.stop(), /Flood did not stop within 5 s/);
    const [, signal] = await closed;
    assert.equal(signal, 'SIGKILL');
  } finally {
    flood.kill();
  }
});
