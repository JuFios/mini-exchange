import { toPeriod } from '../../src/reconciliation/reconciliation-query';

it('accepts millisecond bounds and fills open ends', () => {
  const period = toPeriod({ from: '2026-01-01T00:00:00.000Z', instrument: 'ABC' });
  expect(period).toMatchObject({ from: '2026-01-01T00:00:00.000Z', instrument: 'ABC' });
  expect(Date.parse(period.to)).toBeGreaterThan(Date.parse(period.from));
});

it.each([
  { from: '2026-01-01' },
  { from: '2026-02-29T00:00:00.000Z' },
  { to: '2026-04-31T00:00:00.000Z' },
  { to: '2026-01-01T00:00:00Z' },
  { instrument: 'USD' },
  { from: '2026-01-02T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
])('rejects %j, which the command line could otherwise pass through', (query) => {
  expect(() => toPeriod(query)).toThrow();
});

it('accepts a real leap day without normalizing the supplied bounds', () => {
  const period = { from: '2024-02-29T00:00:00.000Z', to: '2024-03-01T00:00:00.000Z' };
  expect(toPeriod(period)).toEqual(period);
});
