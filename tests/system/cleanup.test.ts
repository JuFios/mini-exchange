import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanup } from './helpers';

test('runs every cleanup step and fails a passing run on the first problem', async () => {
  const ran: number[] = [];
  const problem = new Error('cancel failed');
  await assert.rejects(
    cleanup(
      undefined,
      () => ran.push(1),
      () => {
        throw problem;
      },
      async () => ran.push(3),
    ),
    problem,
  );
  assert.deepEqual(ran, [1, 3]);
});

test('reports several problems of a passing run together', async () => {
  await assert.rejects(
    cleanup(
      undefined,
      () => {
        throw new Error('a');
      },
      async () => {
        throw new Error('b');
      },
    ),
    (error: unknown) => error instanceof AggregateError && error.errors.length === 2,
  );
});

test('keeps the scenario error when cleanup also fails', async (t) => {
  const printed = t.mock.method(console, 'error', () => undefined);
  const ran: number[] = [];
  await cleanup(
    new Error('scenario failed'),
    () => {
      throw new Error('cleanup failed');
    },
    () => ran.push(2),
  );
  assert.deepEqual(ran, [2]);
  assert.equal(printed.mock.callCount(), 1);
});
