import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SETTLEMENT_GROUP } from '../../src/outbox/settlement-queue';
import { settlementStream } from '../../src/outbox/streams';

// Метрики черги settlement engine читає з групи й stream, які створює settlement.
it('reads the consumer group and streams that settlement uses', () => {
  const source = readFileSync(
    join(__dirname, '../../../settlement-service/src/consumer/streams.ts'),
    'utf8',
  );
  expect(source).toContain(`export const GROUP = '${SETTLEMENT_GROUP}';`);
  expect(source).toContain('`exchange:settlement:{${instrument}}`');
  expect(settlementStream('ABC')).toBe('exchange:settlement:{ABC}');
});
