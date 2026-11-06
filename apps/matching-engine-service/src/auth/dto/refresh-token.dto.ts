import { IsString, MaxLength } from 'class-validator';

export class RefreshTokenDto {
  @IsString({ message: 'Некоректний токен оновлення' })
  @MaxLength(4096, { message: 'Некоректний токен оновлення' })
  refreshToken: string;
}
