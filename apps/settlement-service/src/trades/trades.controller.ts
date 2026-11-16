import { EngineOutboxClient } from '../consumer/engine-outbox.client';
import { parseSettlementEvent, InvalidEventError } from '../consumer/settlement-event';
import { describeTrade } from './trades.service';
import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Post,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { InvalidEventFilter } from '../consumer/invalid-event.filter';
import { InternalTokenGuard } from '../security/internal-token.guard';
import { TradesService } from './trades.service';
import { SettleTradeDto } from './dto/settle-trade.dto';

@Controller('trades')
@UseGuards(InternalTokenGuard)
@UseFilters(InvalidEventFilter)
export class TradesController {
  constructor(
    private readonly trades: TradesService,
    private readonly outbox: EngineOutboxClient,
  ) {}

  @Post('settle')
  @HttpCode(200)
  async settle(@Body() dto: SettleTradeDto) {
    const canonical = parseSettlementEvent((await this.outbox.trade(dto.tradeId)).envelope);
    if (canonical.type !== 'trade.executed') throw new InvalidEventError('Not a committed trade');
    if (describeTrade(canonical.trade).hash !== describeTrade(dto).hash)
      throw new ConflictException('Дані угоди відрізняються');
    const result = await this.trades.settle(canonical.trade);
    if (result.status === 'conflict') {
      throw new ConflictException({ code: 'TRADE_CONFLICT', message: 'Дані угоди відрізняються' });
    }
    return result;
  }
}
