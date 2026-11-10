import { io } from 'socket.io-client';
import { engineApp } from './engine-app';

const api = engineApp();
const allowed = 'http://localhost:3000';
const forbidden = 'https://foreign.example.test';

it('allows the configured origin in HTTP and blocks it for a foreign origin', async () => {
  const get = (origin: string) =>
    api.request('/instruments', 'GET', undefined, undefined, { origin });
  expect((await get(allowed)).headers.get('access-control-allow-origin')).toBe(allowed);
  const rejected = await get(forbidden);
  expect(rejected.headers.has('access-control-allow-origin')).toBe(false);
  expect(rejected.headers.get('x-content-type-options')).toBe('nosniff');
});

it('rejects WebSocket upgrades from a foreign origin for every namespace', async () => {
  for (const namespace of ['/', '/market', '/private']) {
    const socket = io(api.url() + namespace, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { origin: forbidden },
    });
    try {
      const result = await new Promise<string>((resolve) => {
        socket.once('connect', () => resolve('connected'));
        socket.once('connect_error', (error) => resolve(error.message));
      });
      expect(result).toBe('websocket error');
    } finally {
      socket.disconnect();
    }
  }
  const socket = io(api.url() + '/market', {
    transports: ['websocket'],
    reconnection: false,
    extraHeaders: { origin: allowed },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('connect_error', reject);
    });
  } finally {
    socket.disconnect();
  }
});
