import { toRejectedInternal } from '../../src/engine/command-applier';

it('releases the full rejected buy reservation with an empty delta', () => {
  const result = toRejectedInternal(
    { bids: [], asks: [] },
    {
      id: 'id',
      ownerId: 'u',
      side: 'buy',
      price: 10000n,
      quantity: 200000000n,
      remaining: 200000000n,
      prioritySeq: 1n,
    },
  );
  expect(result).toMatchObject({
    outcome: 'rejected_internal',
    levelChanges: [],
    trades: [],
    closed: [{ reason: 'rejected', releasedAmount: 2000000000000n }],
  });
  expect(result.orderChanges).toMatchObject([{ status: 'cancelled', cancelReason: 'rejected' }]);
});
