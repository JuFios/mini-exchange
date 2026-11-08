import { ServiceUnavailableException } from '@nestjs/common';

// Пул PG спільний із worker. Без межі черга запитів забирає в нього всі з'єднання.
export class ConcurrencyLimit {
  private active = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly maxActive: number,
    private readonly maxWaiting: number,
    private readonly maxWaitMs: number,
    private readonly busyCode: string,
  ) {}

  private busy(): ServiceUnavailableException {
    return new ServiceUnavailableException({ code: this.busyCode });
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxActive) {
      this.active++;
      return;
    }
    if (this.waiting.length >= this.maxWaiting) throw this.busy();
    // Слот передається напряму, тож `active` не змінюється між release і resume.
    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = this.waiting.indexOf(entry);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(this.busy());
      }, this.maxWaitMs);
      this.waiting.push(entry);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await work();
    } finally {
      this.release();
    }
  }
}
