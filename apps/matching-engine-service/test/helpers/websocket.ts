import { io, Socket } from 'socket.io-client';

export interface Received {
  event: string;
  payload: unknown;
}

/** Підключає клієнта до namespace; відхилення на handshake стає помилкою з повідомленням сервера. */
export function connect(base: string, namespace: string, token?: string): Promise<Socket> {
  const socket = io(`${base}${namespace}`, {
    transports: ['websocket'],
    reconnection: false,
    timeout: 3000,
    ...(token !== undefined && { auth: { token } }),
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

/** Складає в масив події сокета в порядку надходження. */
export function record(socket: Socket, events: string[]): Received[] {
  const received: Received[] = [];
  for (const event of events)
    socket.on(event, (payload: unknown) => received.push({ event, payload }));
  return received;
}

export function emitWithAck<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeout = 5000,
): Promise<T> {
  return socket.timeout(timeout).emitWithAck(event, payload) as Promise<T>;
}

/** Чекає розриву з'єднання сервером і повертає момент розриву. */
export function disconnected(socket: Socket, timeout = 10000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Socket stayed connected')), timeout);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve(Date.now());
    });
  });
}

/** Корисні навантаження подій одного імені в порядку надходження. */
export function payloads<T = Record<string, string>>(received: Received[], event: string): T[] {
  return received.filter((item) => item.event === event).map(({ payload }) => payload as T);
}
