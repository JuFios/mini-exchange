import { CommandApplier } from '../../src/engine/command-applier';
import { engineApp } from './engine-app';

const { register, submit, request, restart, database } = engineApp();

it('does not let cursor parameters replace the authenticated owner or instrument filter', async () => {
  const alice = await register();
  const bob = await register();
  const own = (await (await submit(alice)).json()).order;
  const foreign = (await (await submit(bob, { instrument: 'XYZ' })).json()).order;
  const cursor = Buffer.from(
    JSON.stringify({
      createdAt: '2099-01-01T00:00:00.000Z',
      id: own.id,
      ownerId: foreign.ownerId,
      instrument: 'XYZ',
    }),
  ).toString('base64url');
  const response = await request(`/orders?instrument=ABC&cursor=${cursor}`, 'GET', alice);
  expect(response.status).toBe(200);
  expect((await response.json()).map((order: { id: string }) => order.id)).toEqual([own.id]);
});

it("does not take a page boundary from another user's order in the cursor", async () => {
  const alice = await register();
  const bob = await register();
  const sub = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).sub;
  // Мікросекунди мають лише імпортовані заявки, тож обидві вставлено напряму.
  const [{ id: own }] = await database().query(
    `INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,created_at)
    VALUES ($1,'ABC','sell',100,1,1,'open','2026-11-01T00:00:00.123100Z') RETURNING id`,
    [sub(alice)],
  );
  const [{ id: foreign }] = await database().query(
    `INSERT INTO orders(owner_id,instrument,side,price,quantity,remaining_quantity,status,created_at)
    VALUES ($1,'ABC','sell',100,1,1,'open','2026-11-01T00:00:00.123500Z') RETURNING id`,
    [sub(bob)],
  );
  const cursor = Buffer.from(
    JSON.stringify({ createdAt: '2026-11-01T00:00:00.123Z', id: foreign }),
  ).toString('base64url');
  const response = await request(`/orders?cursor=${cursor}`, 'GET', alice);
  expect(response.status).toBe(200);
  // Межа — час із курсора (.123000), а не точний час чужої заявки (.123500).
  expect((await response.json()).map((order: { id: string }) => order.id)).not.toContain(own);
});

it.each([true, false])(
  'publishes the actual level after a failed cancellation (another order: %s)',
  async (keepSecond) => {
    const owner = await register();
    const first = (await (await submit(owner)).json()).order;
    if (keepSecond) await submit(owner, { quantity: 2 });
    const applier = new CommandApplier();
    await restart({}, (builder) =>
      builder.overrideProvider(CommandApplier).useValue({
        apply: (...args: Parameters<CommandApplier['apply']>) => {
          if (args[1].type === 'cancel') throw new Error('cancel failure');
          return applier.apply(...args);
        },
      }),
    );
    expect((await request(`/orders/${first.id}`, 'DELETE', owner)).status).toBe(200);
    const seq = keepSecond ? '3' : '2';
    expect(
      await database().query("SELECT payload FROM outbox WHERE type='book.delta' AND seq=$1", [
        seq,
      ]),
    ).toEqual([
      {
        payload: {
          instrument: 'ABC',
          seq,
          changes: [
            {
              side: 'ask',
              price: '100.00',
              quantity: keepSecond ? '2.00000000' : '0',
              orders: keepSecond ? 1 : 0,
            },
          ],
        },
      },
    ]);
    expect(await (await request('/orders/book?instrument=ABC')).json()).toMatchObject({
      asks: keepSecond ? [{ quantity: '2.00000000', orders: 1 }] : [],
    });
  },
);
