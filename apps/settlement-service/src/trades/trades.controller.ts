import { Body, ConflictException, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../security/internal-token.guard';
import { TradesService } from './trades.service';
import { SettleTradeDto } from './dto/settle-trade.dto';

@Controller('trades')
@UseGuards(InternalTokenGuard)
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  @Post('settle')
  @HttpCode(200)
  async settle(@Body() dto: SettleTradeDto) {
    const result = await this.trades.settle(dto);
    if (result.status === 'conflict') {
      throw new ConflictException({ code: 'TRADE_CONFLICT', message: 'Дані угоди відрізняються' });
    }
    return result;
  }
}
