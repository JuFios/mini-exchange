import { IsBoolean, IsString, MaxLength, ValidateIf } from 'class-validator';

export class RefreshTokenDto {
  @IsString({ message: 'Некоректний токен оновлення' })
  @MaxLength(4096, { message: 'Некоректний токен оновлення' })
  refreshToken: string;
}

export class RefreshSessionDto extends RefreshTokenDto {
  /**
   * `false` — лише новий access JWT, refresh-токен і стан сесії не змінюються. Для запитів, які
   * може обірвати чужа сторінка: обірвана ротація лишила б у клієнта старий refresh, і його
   * наступне використання після grace відкликало б сесію.
   */
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsBoolean({ message: 'Некоректний параметр ротації' })
  rotate?: boolean;
}
