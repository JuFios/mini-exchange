import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsUUID, ValidateIf } from 'class-validator';
import { setTimeout } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/guards/roles.guard';

const MAX_IDS = 1000;
const LOCK_WAIT_MS = 500;
const LOCK_ATTEMPTS = 6;
const LOCK_RETRY_PAUSE_MS = 100;
const LOCK_NOT_AVAILABLE = '55P03';

export class RedriveDto {
  @ValidateIf((_object, value) => value !== undefined)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  tradeIds?: string[];

  @ValidateIf((_object, value) => value !== undefined)
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  orderIds?: string[];
}

@Controller('admin/outbox/redrive')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['admin'])
export class OutboxRedriveController {
  constructor(private readonly source: DataSource) {}

  /**
   * Повертає події розрахунку (угоди) і закриття заявок у хвіст outbox із новою позицією,
   * тож relay публікує їх знову. Settlement ідемпотентний, тому зайва публікація безпечна.
   */
  @Post()
  @HttpCode(200)
  async redrive(@Body() { tradeIds = [], orderIds = [] }: RedriveDto) {
    if (!tradeIds.length && !orderIds.length)
      throw new BadRequestException('Потрібен tradeIds або orderIds');
    const lower = (ids: string[]) => ids.map((id) => id.toLowerCase());
    // Нова позиція має бути більшою за позиції рядків, які власник інструмента ще не закомітив:
    // relay відхиляє меншу позицію для пари stream/інструмент і зупинився б на такому рядку.
    // SHARE ROW EXCLUSIVE чекає на відкриті вставки власника й на транзакцію relay. Relay бере
    // ROW EXCLUSIVE до row lock, тож обидві сторони блокують у тому самому порядку.
    // Поки redrive стоїть у черзі за блокуванням, нові вставки власника чекають за ним. Тому
    // одне очікування коротке, а за паузу між спробами черга вставок проходить.
    for (let attempt = 1; ; attempt++) {
      try {
        const [rows]: [unknown[]] = await this.source.transaction(async (db) => {
          await db.query(`SET LOCAL lock_timeout = ${LOCK_WAIT_MS}`);
          await db.query('LOCK TABLE outbox IN SHARE ROW EXCLUSIVE MODE');
          return db.query(
            `UPDATE outbox SET id = nextval(pg_get_serial_sequence('outbox', 'id')), published_at = NULL
         WHERE (type = 'trade.executed' AND payload->>'tradeId' = ANY($1::text[]))
            OR (type = 'order.closed' AND payload->>'orderId' = ANY($2::text[])) RETURNING id`,
            [lower(tradeIds), lower(orderIds)],
          );
        });
        return { requeued: rows.length };
      } catch (error) {
        const code = (error as { driverError?: { code?: string } }).driverError?.code;
        if (code !== LOCK_NOT_AVAILABLE || attempt === LOCK_ATTEMPTS) throw error;
        await setTimeout(LOCK_RETRY_PAUSE_MS);
      }
    }
  }
}
