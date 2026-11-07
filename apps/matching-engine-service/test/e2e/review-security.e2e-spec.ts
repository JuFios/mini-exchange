import { CommandApplier } from '../../src/engine/command-applier';
import { engineApp } from './engine-app';

const { register, submit, request, restart, database } = engineApp();

it('does not let cursor parameters replace the authenticated owner or instrument filter', async () => {
  const alice = await register();
  const bob = await register();
  const own = (await (await submit(alice)).json()).order;
  const foreign = (await (await submit(bob, { instrument: 'XYZ' })).json()).order;
  const cursor = Buffer.from(JSON.stringify({ createdAt: '2099-01-01T00:00:00.000Z', id: own.id, ownerId: foreign.ownerId, instrument: 'XYZ' })).toString('base64url');
  const response = await request(`/orders?instrument=ABC&cursor=${cursor}`, 'GET', alice);
  expect(response.status).toBe(200);
  expect((await response.json()).map((order: { id: string }) => order.id)).toEqual([own.id]);
});

it('publishes the remaining level when a failed cancellation removes one of two resting orders', async () => {
  const owner = await register();
  const first = (await (await submit(owner)).json()).order;
  await submit(owner, { quantity: 2 });
  const applier = new CommandApplier();
  await restart({}, (builder) => builder.overrideProvider(CommandApplier).useValue({
    apply: (...args: Parameters<CommandApplier['apply']>) => {
      if (args[1].type === 'cancel') throw new Error('cancel failure');
      return applier.apply(...args);
    },
  }));
  expect((await request(`/orders/${first.id}`, 'DELETE', owner)).status).toBe(200);
  expect(await database().query("SELECT payload FROM outbox WHERE type='book.delta'"))
    .toEqual([{ payload: { instrument: 'ABC', seq: '3', changes: [{ side: 'ask', price: '100.00', quantity: '2.00000000', orders: 1 }] } }]);
  expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({ asks: [{ quantity: '2.00000000', orders: 1 }] });
});
