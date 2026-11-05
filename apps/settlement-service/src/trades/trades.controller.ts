import { Body, Controller, Post } from '@nestjs/common';
import { TradesService } from './trades.service';
import { SettleTradeDto } from './dto/settle-trade.dto';

@Controller('trades')
export class TradesController {
  constructor(private readonly trades: TradesService) {}

  // TODO: замінити на консюмер черги подій (партиційованої за instrument),
  // а не прямий HTTP-виклик. Ендпоінт лишається зручним для тестування.
  @Post('settle')
  settle(@Body() dto: SettleTradeDto) {
    return this.trades.settle(dto);
  }
}
