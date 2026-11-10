import fc from 'fast-check';
import { checkBatch } from '../../src/realtime/replica-lag';

// `firstId` лежить за курсором лише тоді, коли stream перестворено.
const counters = (added: number, length: number, firstId = 1) => ({
  added: BigInt(added),
  length: BigInt(length),
  firstId: BigInt(firstId),
});

// Після втрати база перевірки переходить на хвіст stream: `verified` дорівнює `added`.

describe('checkBatch', () => {
  it('sees no loss while the oldest stored entry follows the last verified one', () => {
    // Додано 100, обрізано 40, прочитано 40, пачка 10: найстаріший наявний — 41-й.
    expect(checkBatch(40n, 1000n, 10, counters(100, 60))).toEqual({ lost: false, verified: 50n });
    expect(checkBatch(0n, 0n, 3, counters(3, 3))).toEqual({ lost: false, verified: 3n });
  });

  it('sees entries trimmed before they were read', () => {
    // Прочитано 40, найстаріший наявний — 46-й: записи 41–45 втрачено.
    expect(checkBatch(40n, 1000n, 10, counters(100, 55))).toEqual({ lost: true, verified: 100n });
  });

  it('flags a window that moved past the last verified entry, even if that entry was read', () => {
    // Пачка прочитана, але вікно встигло піти далі за неї до перевірки: це край вікна, хибна тривога допустима.
    expect(checkBatch(40n, 1000n, 10, counters(100, 60)).lost).toBe(false);
    expect(checkBatch(40n, 1000n, 10, counters(100, 59)).lost).toBe(true);
  });

  it('sees a stream that was deleted and recreated with fewer entries than were read', () => {
    expect(checkBatch(100n, 1000n, 2, counters(3, 3, 2000))).toEqual({ lost: true, verified: 3n });
  });

  it('sees a stream that was recreated and has grown past what was read', () => {
    // Прочитано 3 записи; stream перестворено, у ньому вже 10, перший новіший за курсор.
    expect(checkBatch(3n, 1000n, 5, counters(10, 10, 2000)).lost).toBe(true);
  });

  it('does not take a stream that has simply grown for a recreated one', () => {
    expect(checkBatch(3n, 1000n, 5, counters(10, 10, 1)).lost).toBe(false);
  });
});

/** Модель Redis stream: ID зростають, ординал рахує додані записи, обрізання знімає найстаріші. */
class SimStream {
  entries: { id: number; ordinal: number }[] = [];
  added = 0;
  private nextId = 1;
  unreadRemoved = false;

  append(count: number) {
    for (let i = 0; i < count; i++) this.entries.push({ id: this.nextId++, ordinal: ++this.added });
  }
  trimTo(length: number, cursor: number) {
    while (this.entries.length > length) {
      const removed = this.entries.shift()!;
      if (removed.id > cursor) this.unreadRemoved = true;
    }
  }
  reset(cursor: number) {
    if (this.entries.some(({ id }) => id > cursor)) this.unreadRemoved = true;
    this.entries = [];
    this.added = 0;
  }
  after(cursor: number, max: number) {
    return this.entries.filter(({ id }) => id > cursor).slice(0, max);
  }
  counters() {
    return {
      added: BigInt(this.added),
      length: BigInt(this.entries.length),
      firstId: BigInt(this.entries[0]?.id ?? 0),
    };
  }
  get lastId() {
    return this.nextId - 1;
  }
}

describe('checkBatch against a simulated stream', () => {
  const op = fc.oneof(
    fc.record({ kind: fc.constant('append' as const), n: fc.integer({ min: 1, max: 6 }) }),
    fc.record({ kind: fc.constant('trim' as const), n: fc.integer({ min: 0, max: 8 }) }),
    fc.record({ kind: fc.constant('reset' as const), n: fc.constant(0) }),
    fc.record({
      kind: fc.constant('read' as const),
      n: fc.integer({ min: 1, max: 5 }),
      trimAfter: fc.boolean(),
    }),
  );

  it('never misses lost entries and stays silent on an undisturbed stream', () => {
    fc.assert(
      fc.property(fc.array(op, { minLength: 1, maxLength: 60 }), (ops) => {
        const stream = new SimStream();
        let cursor = 0;
        let verified = 0n;
        // Хибні тривоги допустимі лише після обрізання між читанням і перевіркою чи перестворення.
        let disturbed = false;
        for (const step of ops) {
          if (step.kind === 'append') stream.append(step.n);
          else if (step.kind === 'trim') stream.trimTo(step.n, cursor);
          else if (step.kind === 'reset') {
            stream.reset(cursor);
            disturbed = true;
          } else {
            const batch = stream.after(cursor, step.n);
            if (batch.length === 0) continue;
            const truth = stream.unreadRemoved;
            stream.unreadRemoved = false;
            const before = cursor;
            cursor = batch[batch.length - 1].id;
            if (step.trimAfter) {
              stream.trimTo(Math.max(0, stream.entries.length - 1), cursor);
              disturbed = true;
            }
            const result = checkBatch(verified, BigInt(before), batch.length, stream.counters());
            if (truth) expect(result.lost).toBe(true);
            else if (!disturbed) expect(result.lost).toBe(false);
            if (result.lost) {
              // Читач переходить на хвіст: непрочитане після втрати свідомо пропускається.
              cursor = stream.lastId;
              expect(result.verified).toBe(BigInt(stream.added));
            } else {
              expect(result.verified).toBe(BigInt(batch[batch.length - 1].ordinal));
            }
            verified = result.verified;
            disturbed = false;
          }
        }
      }),
      { numRuns: 500 },
    );
  });
});
