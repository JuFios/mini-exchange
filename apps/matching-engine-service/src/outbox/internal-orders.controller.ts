import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ArrayMaxSize, ArrayUnique, IsArray, IsUUID } from 'class-validator';
import { DataSource } from 'typeorm';
import { InternalTokenGuard } from '../security/internal-token.guard';

export const MAX_TERMINAL_LOOKUP = 1000;

export class TerminalOrdersBody {
  @IsArray()
  @ArrayMaxSize(MAX_TERMINAL_LOOKUP)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  orderIds: string[];
}

@Controller('internal/orders')
@UseGuards(InternalTokenGuard)
export class InternalOrdersController {
  constructor(private readonly source: DataSource) {}

  /**
   * Із переданих заявок повертає термінальні (`filled`, `cancelled`) і час переходу.
   * Settlement питає про активні резерви, а не про всі заявки: їх мало, термінальних багато.
   * POST, бо 1000 UUID не вміщаються в рядок запиту; стан маршрут не змінює.
   */
  @Post('terminal')
  @HttpCode(200)
  async terminal(@Body() { orderIds }: TerminalOrdersBody) {
    const orders = await this.source.query(
      `SELECT id AS "orderId", instrument, status, updated_at AS "closedAt"
       FROM orders WHERE id = ANY($1::uuid[]) AND status IN ('filled','cancelled')
       ORDER BY id`,
      [orderIds],
    );
    return { orders };
  }
}
