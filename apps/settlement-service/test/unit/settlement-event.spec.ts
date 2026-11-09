import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { classifyFailure, PayloadConflictError } from '../../src/consumer/failure-kind';
import { InvalidEventError, parseSettlementEvent } from '../../src/consumer/settlement-event';

const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '../../../matching-engine-service/test/contract/fixtures/events-v1.json'),
    'utf8',
  ),
);
const envelope = (
  change: (event: Record<string, unknown> & { payload: Record<string, unknown> }) => void,
  type = 'trade.executed',
) => {
  const event = structuredClone(fixtures[type]);
  change(event);
  return JSON.stringify(event);
};

it('reads the engine trade fixture and keeps the trace ID', () => {
  const traced = envelope(
    (e) => (e.traceparent = '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01'),
  );
  expect(parseSettlementEvent(traced)).toMatchObject({
    type: 'trade.executed',
    trade: { price: '100.00', buyLimitPrice: '101.00', baseAsset: 'ABC' },
    traceId: '0123456789abcdef0123456789abcdef',
  });
  expect(parseSettlementEvent(JSON.stringify(fixtures['order.closed']))).toMatchObject({
    type: 'order.closed',
    closed: { releasedAmount: '10100' },
  });
});

it.each([
  ['not JSON', undefined],
  ['an unknown version', envelope((e) => (e.version = 2))],
  ['a foreign producer', envelope((e) => (e.producer = 'settlement'))],
  ['an unknown type', envelope((e) => (e.type = 'book.delta'))],
  ['a missing payload', envelope((e) => Reflect.deleteProperty(e, 'payload'))],
  ['a non-string amount', envelope((e) => (e.payload.price = 100))],
  ['a bad trade ID', envelope((e) => (e.payload.tradeId = 'x'))],
  ['a bad date', envelope((e) => (e.payload.executedAt = 'yesterday'))],
  ['a zero release', envelope((e) => (e.payload.releasedAmount = '0'), 'order.closed')],
  ['a fractional release', envelope((e) => (e.payload.releasedAmount = '1.5'), 'order.closed')],
])('rejects %s as an invalid event', (_name, raw) => {
  expect(() => parseSettlementEvent(raw)).toThrow(InvalidEventError);
});

it('classifies failures so only environment errors are retried without limit', () => {
  const sql = (code: string) => Object.assign(new Error('sql'), { driverError: { code } });
  expect(classifyFailure(new InvalidEventError('x'))).toBe('invalid');
  expect(classifyFailure(new PayloadConflictError('x'))).toBe('invalid');
  expect(classifyFailure(new HttpException('bad', 400))).toBe('invalid');
  expect(classifyFailure(sql('23514'))).toBe('invalid');
  for (const code of ['40001', '40P01', '08006', '57014', '55P03', '25P03', '53300'])
    expect(classifyFailure(sql(code))).toBe('transient');
  expect(classifyFailure(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe('transient');
  expect(classifyFailure(new Error('Connection terminated unexpectedly'))).toBe('transient');
  expect(classifyFailure(new Error('Command timed out'))).toBe('transient');
  expect(
    classifyFailure(new Error('Client has encountered a connection error and is not queryable')),
  ).toBe('transient');
  for (const reply of [
    'LOADING Redis is loading',
    'READONLY You can',
    'MISCONF Redis is',
    'OOM command not allowed',
    'BUSY Redis is busy',
  ])
    expect(classifyFailure(new Error(reply))).toBe('transient');
  expect(classifyFailure(new HttpException('conflict', 409))).toBe('other');
  expect(classifyFailure(new Error('boom'))).toBe('other');
});

it.each(['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])('treats %s as transient', (code) => {
  expect(classifyFailure(Object.assign(new Error('network'), { code }))).toBe('transient');
});
