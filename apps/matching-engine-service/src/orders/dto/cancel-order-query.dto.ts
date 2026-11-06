import { IsOptional, IsString } from 'class-validator';

export class CancelOrderQueryDto {
  @IsOptional()
  @IsString({ message: 'Інструмент має бути рядком' })
  instrument?: string;
}
