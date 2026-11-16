import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { InternalTokenGuard, OutboxTokenScope } from '../security/internal-token.guard';
import { InstrumentCatalog } from '../orders/instrument-catalog';
import { outboxStreamFields, OutboxStreamRow } from './streams';

const COLUMNS =
  'event_id,type,version,instrument,seq,payload,traceparent,created_at,settlement_position';
const FINANCIAL = "type IN ('trade.executed','order.closed')";
interface Row extends OutboxStreamRow {
  settlement_position: string;
}

function committed(row: Row) {
  const fields = outboxStreamFields(row);
  return { position: row.settlement_position, envelope: fields[fields.length - 1] };
}

@Controller('internal/outbox')
@UseGuards(InternalTokenGuard)
@OutboxTokenScope()
export class InternalOutboxController {
  constructor(
    private readonly source: DataSource,
    private readonly catalog: InstrumentCatalog,
  ) {}

  @Get('events/:id')
  async event(@Param('id', ParseUUIDPipe) id: string) {
    const [row]: Row[] = await this.source.query(
      `SELECT ${COLUMNS} FROM outbox WHERE event_id=$1 AND ${FINANCIAL}`,
      [id],
    );
    if (!row) throw new NotFoundException('Подію не знайдено');
    return committed(row);
  }

  @Get('trades/:id')
  async trade(@Param('id', ParseUUIDPipe) id: string) {
    const [row]: Row[] = await this.source.query(
      `SELECT ${COLUMNS} FROM outbox WHERE type='trade.executed' AND payload->>'tradeId'=$1`,
      [id],
    );
    if (!row) throw new NotFoundException('Угоду не знайдено');
    return committed(row);
  }

  @Get('page')
  async page(@Query('instrument') instrument: string, @Query('after') after = '0') {
    this.catalog.require(instrument);
    if (!/^(0|[1-9][0-9]{0,18})$/.test(after) || BigInt(after) > 9223372036854775807n)
      throw new BadRequestException('Некоректна позиція');
    const rows: Row[] = await this.source.query(
      `SELECT ${COLUMNS} FROM outbox WHERE instrument=$1 AND settlement_position>$2 AND ${FINANCIAL}
       ORDER BY settlement_position LIMIT 50`,
      [instrument, after],
    );
    return { events: rows.map(committed) };
  }

  @Get('compensation/:id')
  async compensation(@Param('id', ParseUUIDPipe) id: string) {
    // Ці стани вже виключають прийняття: TX2 intake змінює лише reserving.
    const [row] = await this.source.query(`SELECT status FROM order_requests WHERE order_id=$1`, [
      id,
    ]);
    return { allowed: row?.status === 'releasing' || row?.status === 'expired' };
  }
}
