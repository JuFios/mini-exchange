import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsOptional, IsUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/guards/roles.guard';

const MAX_IDS = 1000;

export class RedriveDto {
  @IsOptional()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_IDS)
  @ArrayUnique()
  @IsUUID(undefined, { each: true })
  tradeIds?: string[];

  @IsOptional()
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
    // SHARE ROW EXCLUSIVE чекає на відкриті вставки власника й не блокує вибірку relay.
    const [rows]: [unknown[]] = await this.source.transaction(async (db) => {
      await db.query("SET LOCAL lock_timeout = '3s'");
      await db.query('LOCK TABLE outbox IN SHARE ROW EXCLUSIVE MODE');
      return db.query(
        `UPDATE outbox SET id = nextval(pg_get_serial_sequence('outbox', 'id')), published_at = NULL
         WHERE (type = 'trade.executed' AND payload->>'tradeId' = ANY($1::text[]))
            OR (type = 'order.closed' AND payload->>'orderId' = ANY($2::text[])) RETURNING id`,
        [lower(tradeIds), lower(orderIds)],
      );
    });
    return { requeued: rows.length };
  }
}
