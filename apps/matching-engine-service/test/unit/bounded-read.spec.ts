import { EventEmitter } from 'node:events';
import { DataSource } from 'typeorm';
import { boundedRead } from '../../src/database/bounded-read';

it('destroys a client on cancellation and releases a late acquisition without running SQL', async () => {
  for (const late of [false, true]) {
    const controller = new AbortController();
    const client = Object.assign(new EventEmitter(), {
      query: jest.fn(() => new Promise<never>(() => undefined)),
      release: jest.fn(),
    });
    let acquire!: (value: typeof client) => void;
    const connection = late
      ? new Promise<typeof client>((resolve) => {
          acquire = resolve;
        })
      : Promise.resolve(client);
    const source = { driver: { master: { connect: () => connection } } } as unknown as DataSource;
    const result = boundedRead(source, controller.signal, async () => []);
    const rejected = expect(result).rejects.toThrow('cancelled');
    await Promise.resolve();
    controller.abort(new Error('cancelled'));
    if (late) acquire(client);
    await rejected;
    await Promise.resolve();
    expect(client.release).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledWith(late ? undefined : true);
    if (late) expect(client.query).not.toHaveBeenCalled();
    if (!late) client.emit('error', new Error('late network error'));
  }
});
