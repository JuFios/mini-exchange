import { IsEmail, MinLength } from 'class-validator';
import { FitsBcrypt } from '../password';

export class RegisterDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  @FitsBcrypt('Пароль задовгий: щонайбільше 72 байти UTF-8')
  password: string;
}
