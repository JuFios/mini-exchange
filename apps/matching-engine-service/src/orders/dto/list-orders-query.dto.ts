import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ListOrdersQueryDto {
  @IsOptional()
  @IsIn(['active', 'filled', 'all'], { message: 'Некоректний статус' })
  status?: string;

  @IsOptional()
  @IsString({ message: 'Інструмент має бути рядком' })
  instrument?: string;

  @IsOptional()
  @Matches(/^(?:[1-9][0-9]?|100)$/, { message: 'Ліміт має бути від 1 до 100' })
  limit?: string;

  @IsOptional()
  @IsString({ message: 'Некоректний курсор' })
  @MaxLength(256, { message: 'Некоректний курсор' })
  cursor?: string;
}
