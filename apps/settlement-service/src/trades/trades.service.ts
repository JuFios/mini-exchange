import { Injectable, NotImplementedException } from '@nestjs/common';
import { SettleTradeDto } from './dto/settle-trade.dto';

@Injectable()
export class TradesService {
  // TODO: реалізувати рух коштів між гаманцями покупця й продавця та
  // ідемпотентну обробку (повторна доставка того самого tradeId не повинна
  // подвоїти рух коштів) — див. ТЗ, розділ 4.1 і 4.2.
  settle(_dto: SettleTradeDto): never {
    throw new NotImplementedException('Розрахунок угод ще не реалізований');
  }
}
