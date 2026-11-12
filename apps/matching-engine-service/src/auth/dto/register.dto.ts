import { IsEmail, MinLength } from 'class-validator';
import { FitsBcrypt, IsWellFormedPassword } from '../password';

export class RegisterDto {
  @IsEmail()
  email: string;

  @MinLength(8)
  @FitsBcrypt('Пароль задовгий: щонайбільше 72 байти UTF-8')
  @IsWellFormedPassword('Пароль містить некоректні символи')
  password: string;
}
