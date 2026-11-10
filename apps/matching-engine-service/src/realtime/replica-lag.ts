/** ID запису Redis Stream (`<мс>-<номер>`) як число, яке зростає разом із stream. */
export function streamPosition(id: string): bigint {
  const match = /^(\d+)-(\d+)$/.exec(id);
  return match ? (BigInt(match[1]) << 64n) | BigInt(match[2]) : 0n;
}

/**
 * Відставання репліки від stream: що relay уже опублікував і чого репліка ще не прочитала.
 * Позиція — це ID запису, а не `seq` команди: угода й delta однієї команди мають однаковий
 * `seq`, а stream подій користувачів `seq` не має. Під навантаженням відставання коротко
 * ненульове й без зависання, тож саме воно нічого не доводить. Репліка вважається завислою,
 * коли вона відстає й не просувається довше `maxLagMs`.
 */
export class LagTracker {
  private seen = -1n;
  private behind = false;
  private progressAt = 0;
  private lastStale = false;
  private checkedAt: number;

  /**
   * @param validForMs скільки вердикт лишається чинним після останньої успішної перевірки;
   * @param startedAt момент створення: перевірка, що жодного разу не вдалася, теж спливає.
   */
  constructor(
    private readonly maxLagMs: number,
    private readonly validForMs: number,
    startedAt: number,
  ) {
    this.checkedAt = startedAt;
  }

  check(published: bigint, emitted: bigint, now: number): { lag: bigint; stale: boolean } {
    const lag = published > emitted ? published - emitted : 0n;
    // Відлік починається, коли відставання з'явилося, і скидається при просуванні чи наздоганянні.
    if (lag === 0n || emitted !== this.seen || !this.behind) this.progressAt = now;
    this.seen = emitted;
    this.behind = lag > 0n;
    this.lastStale = lag > 0n && now - this.progressAt > this.maxLagMs;
    this.checkedAt = now;
    return { lag, stale: this.lastStale };
  }

  /**
   * Вердикт у момент `now`. Збій перевірки не доводить ні зависання, ні наздоганяння, тож
   * останній вердикт лишається, але не довше за `validForMs`: без свіжого доказу репліка
   * вважається завислою, інакше ізольована від Redis репліка трималася б у ротації безстроково.
   */
  isStale(now: number): boolean {
    return this.lastStale || now - this.checkedAt > this.validForMs;
  }
}

/** Лічильники stream з `XINFO STREAM` (Redis 7.0+). */
export interface StreamCounters {
  /** Скільки записів додано за весь час: `entries-added`. */
  added: bigint;
  /** Скільки записів зараз у stream. */
  length: bigint;
  /** Позиція найстаршого наявного запису (`recorded-first-entry-id`). */
  firstId: bigint;
}

/**
 * Чи пропустив читач записи, які обрізав `MAXLEN` або яких немає через перестворення stream.
 * ID запису цього не показують: `XREAD` просто повертає перший наявний. Тому читач рахує
 * ординали: `verified` записів прочитано до курсора `cursor`, у пачці `batch` ще `batch`.
 * Найстаріший наявний запис має ординал `added − length + 1`; якщо він далі за наступний
 * очікуваний, між ними були записи, яких уже немає. Помилкових пропусків немає; хибна тривога
 * можлива лише коли вікно stream вже зсунулося за щойно прочитану пачку. Після втрати база
 * переходить на хвіст: `verified` дорівнює `added` (читач ставить курсор на `last-generated-id`).
 */
export function checkBatch(
  verified: bigint,
  cursor: bigint,
  batch: number,
  counters: StreamCounters,
): { lost: boolean; verified: bigint } {
  const oldest = counters.added - counters.length + 1n;
  const consumed = verified + BigInt(batch);
  const lost =
    // Прочитано більше, ніж будь-коли додано: stream перестворено з меншою історією.
    counters.added < consumed ||
    oldest > verified + 1n ||
    // Найстаріший наявний запис мав би бути вже прочитаним, але він новіший за курсор:
    // stream перестворено й він встиг вирости.
    (oldest <= verified && counters.firstId > cursor);
  return { lost, verified: lost ? counters.added : consumed };
}

/** Пам'ять про вже оброблені `eventId`: relay може повторити останній запис після збою. */
export class RecentIds {
  private readonly ids = new Set<string>();

  constructor(private readonly capacity: number) {}

  /** Повертає `true`, якщо ID бачимо вперше. */
  add(id: string): boolean {
    if (this.ids.has(id)) return false;
    if (this.ids.size >= this.capacity) this.ids.delete(this.ids.values().next().value as string);
    this.ids.add(id);
    return true;
  }
}
