import { IsIn, IsUUID, Matches } from 'class-validator';
import { ASSETS, Asset } from '../ledger/amount';

export class ReserveDto {
  @IsUUID()
  reservationId: string;

  @IsUUID()
  userId: string;

  @IsIn(ASSETS)
  asset: Asset;

  @Matches(/^[1-9][0-9]{0,37}(?![\s\S])/)
  amount: string;
}
