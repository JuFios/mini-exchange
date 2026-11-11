import assert from 'node:assert/strict';
import { it } from 'node:test';
import { RETRY_MAX_MS } from '../lib/book-session';
import { ApiError } from '../lib/client-api';
import { HISTORY_REFRESH_MS, HISTORY_TIMEOUT_MS, startTradeHistory } from '../lib/trade-history';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Історія з керованим часом. Читання завершує тест: відповідь може прийти й після abort. */
function history() {
  let time = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; handler: () => void }>();
  const handlers = new Map<string, (event: unknown) => void>();
  const reads: {
    signal: AbortSignal;
    resolve(rows: string[]): void;
    reject(error: unknown): void;
  }[] = [];
  const rows: string[][] = [];
  const errors: unknown[] = [];
  const session = startTradeHistory<string[]>(
    { on: (event, handler) => handlers.set(event, handler as (event: unknown) => void) },
    'ABC',
    (signal) => new Promise((resolve, reject) => reads.push({ signal, resolve, reject })),
    { onRows: (value) => rows.push(value), onError: (error) => errors.push(error) },
    {
      setTimeout(handler, ms) {
        timers.set(nextId, { at: time + ms, handler });
        return nextId++;
      },
      clearTimeout: (handle) => timers.delete(handle as number),
    },
    () => time,
  );
  const advance = (ms: number) => {
    time += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at > time) continue;
      timers.delete(id);
      timer.handler();
    }
  };
  const heartbeat = (instrument = 'ABC') =>
    handlers.get('book.heartbeat')!({ instrument, seq: '1' });
  return { session, reads, rows, errors, timers, advance, heartbeat };
}

it('refreshes trade history on heartbeats at a bounded interval when the book is current', async () => {
  const state = history();
  state.heartbeat();
  assert.equal(state.reads.length, 0, 'no refresh before the first snapshot');
  state.session.refresh();
  state.reads[0].resolve(['t1']);
  await flush();
  state.advance(HISTORY_REFRESH_MS - 1);
  state.heartbeat();
  assert.equal(state.reads.length, 1);
  state.advance(1);
  state.heartbeat('XYZ');
  assert.equal(state.reads.length, 1, 'another instrument does not refresh');
  state.heartbeat();
  state.heartbeat();
  assert.equal(state.reads.length, 2, 'one read at a time');
  state.reads[1].resolve(['t2']);
  await flush();
  assert.deepEqual(state.rows, [['t1'], ['t2']]);
});

it('retries a failure that can pass on its own, and waits for a snapshot after a client error', async () => {
  const failures = {
    unavailable: new ApiError(503, 'busy'),
    server: new ApiError(500, 'failed'),
    network: new TypeError('Failed to fetch'),
    timeout: undefined,
    forbidden: new ApiError(403, 'forbidden'),
    invalid: new Error('Invalid trade snapshot'),
  };
  for (const [name, error] of Object.entries(failures)) {
    const state = history();
    state.session.refresh();
    if (error) state.reads[0].reject(error);
    else {
      state.advance(HISTORY_TIMEOUT_MS);
      assert.equal(state.reads[0].signal.aborted, true);
      state.reads[0].reject(new DOMException('aborted', 'AbortError'));
    }
    await flush();
    assert.equal(state.errors.length, 1, name);
    assert.equal(state.timers.size, 0, name);
    state.advance(RETRY_MAX_MS);
    state.heartbeat();
    const permanent = name === 'forbidden' || name === 'invalid';
    assert.equal(state.reads.length, permanent ? 1 : 2, name);
  }
});

it('backs off repeated failures up to the refresh interval and resets after a success', async () => {
  const state = history();
  state.session.refresh();
  const intervals: number[] = [];
  for (let attempt = 0; attempt < 5; attempt++) {
    state.reads.at(-1)!.reject(new ApiError(429, 'busy'));
    await flush();
    const before = state.reads.length;
    let waited = 0;
    while (state.reads.length === before) {
      assert.ok(waited < HISTORY_REFRESH_MS, 'a retry is due within the refresh interval');
      state.advance(1000);
      waited += 1000;
      state.heartbeat();
    }
    intervals.push(waited);
  }
  assert.deepEqual(intervals, [2000, 4000, 8000, 10_000, 10_000]);
  state.reads.at(-1)!.resolve(['t1']);
  await flush();
  state.session.refresh();
  state.reads.at(-1)!.reject(new ApiError(429, 'busy'));
  await flush();
  state.advance(RETRY_MAX_MS);
  state.heartbeat();
  assert.equal(state.reads.length, 8);
});

it('drops the answer of a read superseded by a newer snapshot', async () => {
  const state = history();
  state.session.refresh();
  state.session.refresh();
  assert.equal(state.reads[0].signal.aborted, true);
  state.reads[1].resolve(['new']);
  state.reads[0].resolve(['old']);
  await flush();
  state.session.refresh();
  state.session.refresh();
  state.reads[2].reject(new ApiError(503, 'late'));
  state.reads[3].resolve(['newest']);
  await flush();
  assert.deepEqual(state.rows, [['new'], ['newest']]);
  assert.deepEqual(state.errors, []);
});

it('cancels the read and stops refreshing once stopped', async () => {
  const state = history();
  state.session.refresh();
  state.session.stop();
  assert.equal(state.reads[0].signal.aborted, true);
  assert.equal(state.timers.size, 0);
  state.reads[0].resolve(['late']);
  await flush();
  assert.deepEqual(state.rows, []);
  state.advance(HISTORY_REFRESH_MS);
  state.heartbeat();
  state.session.refresh();
  assert.equal(state.reads.length, 1);
  assert.deepEqual(state.errors, []);
});
