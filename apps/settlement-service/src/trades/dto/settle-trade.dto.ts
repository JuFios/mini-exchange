import { IsIn, IsISO8601, IsString, IsUUID, Matches } from 'class-validator';
import { ASSETS, Asset } from '../../ledger/amount';

export class SettleTradeDto {
  @IsUUID()
  tradeId: string;

  @IsString()
  instrument: string;

  @IsUUID()
  buyOrderId: string;

  @IsUUID()
  sellOrderId: string;

  @IsUUID()
  buyerUserId: string;

  @IsUUID()
  sellerUserId: string;

  @IsIn(ASSETS)
  baseAsset: Asset;

  @IsIn(ASSETS)
  quoteAsset: Asset;

  @IsString()
  price: string;

  @IsString()
  quantity: string;

  @IsString()
  buyLimitPrice: string;

  @IsISO8601({ strict: true, strictSeparator: true })
  @Matches(/T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,3})?(?:Z|[+-][0-9]{2}:[0-9]{2})(?![\s\S])/)
  executedAt: string;
}
