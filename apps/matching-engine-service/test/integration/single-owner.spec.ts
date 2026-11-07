import { io } from 'socket.io-client';
import { DataSource } from 'typeorm';
import { engineApp } from '../e2e/engine-app';
import { waitFor } from '../helpers/wait-for';

const api = engineApp();
it('keeps one writer while both replicas run workers and transfers ownership after shutdown', async () => {
  const peer = await api.build({ INSTANCE_ID: 'peer-owner' });
  try {
    const source = peer.get(DataSource);
    const token = await api.register();
    const before = (
      await source.query(
        "SELECT owner_epoch,owner_instance FROM instrument_state WHERE instrument='ABC'",
      )
    )[0];
    expect(before.owner_instance).toBe('engine-1');
    const results = await Promise.all(Array.from({ length: 20 }, () => api.submit(token)));
    expect(results.every((r) => r.status === 201 || r.status === 202)).toBe(true);
    await waitFor(
      async () =>
        (
          await source.query("SELECT last_applied_seq FROM instrument_state WHERE instrument='ABC'")
        )[0].last_applied_seq === '20',
    );
    const writers = await source.query(
      "SELECT DISTINCT result->>'epoch' AS epoch,result->>'instance' AS instance FROM order_commands",
    );
    expect(writers).toEqual([{ epoch: before.owner_epoch, instance: 'engine-1' }]);
    const peerBook = await (await fetch(`${await peer.getUrl()}/instruments/ABC/book`)).json();
    expect(peerBook).toEqual(await (await api.request('/instruments/ABC/book')).json());
    const socket = io(await peer.getUrl(), { transports: ['websocket'], reconnection: false });
    try {
      const snapshot = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('No standby snapshot')), 3000);
        socket.once('book', (book: unknown) => {
          clearTimeout(timer);
          resolve(book);
        });
        socket.once('connect_error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        socket.emit('subscribe', 'ABC');
      });
      const { bids, asks } = peerBook;
      expect(await snapshot).toEqual({ bids, asks });
    } finally {
      socket.disconnect();
    }
    const started = performance.now();
    await api.restart({ ENGINE_WORKER_ENABLED: false });
    await waitFor(
      async () =>
        (
          await source.query("SELECT owner_instance FROM instrument_state WHERE instrument='ABC'")
        )[0].owner_instance === 'peer-owner',
      2000,
    );
    expect(performance.now() - started).toBeLessThanOrEqual(2000);
    expect(
      BigInt(
        (await source.query("SELECT owner_epoch FROM instrument_state WHERE instrument='ABC'"))[0]
          .owner_epoch,
      ),
    ).toBeGreaterThan(BigInt(before.owner_epoch));
    expect((await api.submit(token)).status).toBe(201);
    expect(
      (
        await source.query(
          "SELECT count(*)::int AS n FROM order_commands WHERE result->>'instance'='peer-owner'",
        )
      )[0].n,
    ).toBe(1);
  } finally {
    await peer.close();
  }
});
