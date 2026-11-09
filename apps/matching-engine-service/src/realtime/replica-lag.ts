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

  constructor(private readonly maxLagMs: number) {}

  check(published: bigint, emitted: bigint, now: number): { lag: bigint; stale: boolean } {
    const lag = published > emitted ? published - emitted : 0n;
    // Відлік починається, коли відставання з'явилося, і скидається при просуванні чи наздоганянні.
    if (lag === 0n || emitted !== this.seen || !this.behind) this.progressAt = now;
    this.seen = emitted;
    this.behind = lag > 0n;
    this.lastStale = lag > 0n && now - this.progressAt > this.maxLagMs;
    return { lag, stale: this.lastStale };
  }

  /** Стан останньої успішної перевірки: потрібен, коли head stream не вдалося прочитати. */
  get stale(): boolean {
    return this.lastStale;
  }
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
