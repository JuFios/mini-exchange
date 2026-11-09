import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';

/**
 * Резерви вмикаються лише на історії, де кожна жива або виконана заявка має резерв.
 * Інакше угоди без резервів не розрахувати, а звірка показувала б їх як пропуски.
 */
@Injectable()
export class ReservationFundingCheck implements OnModuleInit {
  constructor(
    private readonly source: DataSource,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.getOrThrow('RESERVATIONS_ENABLED')) return;
    // Пошук зупиняється на першій заявці без резерву; великий том читається довше за 5 с сесії.
    const [found]: { live: boolean; traded: boolean }[] = await this.source.transaction(
      async (db) => {
        await db.query("SET LOCAL statement_timeout='60s'");
        return db.query(
          `SELECT EXISTS (SELECT 1 FROM orders o WHERE o.status IN ('pending','open','partially_filled')
               AND NOT EXISTS (SELECT 1 FROM order_requests r WHERE r.order_id = o.id AND r.reserved)) AS live,
             EXISTS (SELECT 1 FROM orders o WHERE o.filled_quantity > 0
               AND NOT EXISTS (SELECT 1 FROM order_requests r WHERE r.order_id = o.id AND r.reserved)) AS traded`,
        );
      },
    );
    if (found.live || found.traded)
      throw new Error(
        'RESERVATIONS_ENABLED=true needs an order history with reservations: found ' +
          `${found.live ? 'a live order' : 'no live order'} and ` +
          `${found.traded ? 'a traded order' : 'no traded order'} without one. ` +
          'Cancel the live orders with RESERVATIONS_ENABLED=false; if traded orders remain, ' +
          'recreate the database volume.',
      );
  }
}
