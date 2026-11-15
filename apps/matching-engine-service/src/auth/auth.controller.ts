import { AuthRateGuard } from '../security/rate-limit.guards';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles, RolesGuard } from './guards/roles.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('register')
  @UseGuards(AuthRateGuard)
  @Header('Cache-Control', 'no-store')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @UseGuards(AuthRateGuard)
  @Header('Cache-Control', 'no-store')
  login(@Body() dto: LoginDto) {
    return this.auth.login(dto);
  }

  // Без IP-ліміту входу: користувачі за одним NAT вичерпували б його звичайними оновленнями,
  // а 429 на refresh завершує сесію в браузері. Підібрати підписаний токен неможливо, повтор старого
  // refresh відкликає сесію, тож ліміт тут нічого не захищав.
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  refresh(@Body() dto: RefreshTokenDto) {
    return this.auth.refresh(dto.refreshToken);
  }

  // Роль у claims лишається до `exp`; frontend показує «Стан системи» лише після цієї перевірки.
  // Внутрішнього токена в frontend немає, тож це звичайний маршрут за access JWT: 204, 403 або 401.
  @Get('admin')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(['admin'])
  @HttpCode(HttpStatus.NO_CONTENT)
  @Header('Cache-Control', 'no-store')
  admin(): void {}

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  logout(@Body() dto: RefreshTokenDto) {
    return this.auth.logout(dto.refreshToken);
  }
}
