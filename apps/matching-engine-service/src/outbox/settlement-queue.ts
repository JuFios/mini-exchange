import type Redis from 'ioredis';
import { settlementStream } from './streams';

// Має збігатися з групою consumer settlement (`GROUP` у settlement-service); звіряє unit-тест.
export const SETTLEMENT_GROUP = 'settlement';

export interface SettlementQueue {
  stream: string;
  length: number;
  pending: number;
  lag: number;
}

const count = (value: unknown) =>
  value === null || value === undefined || value === '' ? NaN : Number(value);

/**
 * Довжина stream settlement і стан групи з XINFO GROUPS. NaN означає «невідомо»: Redis не
 * відповів, групи немає (settlement не запускався) або Redis не може порахувати lag.
 */
export async function readSettlementQueue(
  redis: Redis,
  instruments: string[],
): Promise<SettlementQueue[]> {
  return Promise.all(
    instruments.map(async (instrument) => {
      const stream = settlementStream(instrument);
      const [length, groups] = await Promise.all([
        redis.xlen(stream).catch(() => NaN),
        (redis.xinfo('GROUPS', stream) as Promise<unknown[][]>).catch(() => [] as unknown[][]),
      ]);
      const group = groups
        .map((fields) => {
          const info: Record<string, unknown> = {};
          for (let i = 0; i + 1 < fields.length; i += 2) info[String(fields[i])] = fields[i + 1];
          return info;
        })
        .find(({ name }) => name === SETTLEMENT_GROUP);
      return { stream, length, pending: count(group?.pending), lag: count(group?.lag) };
    }),
  );
}
