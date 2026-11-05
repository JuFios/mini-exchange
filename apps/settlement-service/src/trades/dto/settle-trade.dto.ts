import { IsNumberString, IsString, IsUUID } from 'class-validator';

// Каркас DTO для події угоди, що приходитиме з matching-engine-service
// через чергу. Поки що ендпоінт приймає її напряму по HTTP для зручності
// розробки — інтеграцію з реальною чергою потрібно додати (див. ТЗ).
export class SettleTradeDto {
  @IsUUID()
  tradeId: string;

  @IsString()
  instrument: string;

  @IsUUID()
  buyOrderId: string;

  @IsUUID()
  sellOrderId: string;

  @IsNumberString()
  price: string;

  @IsNumberString()
  quantity: string;
}
