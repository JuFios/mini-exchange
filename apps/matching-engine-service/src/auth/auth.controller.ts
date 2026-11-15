import type { Request } from 'express';
import { AuthRateGuard } from '../security/rate-limit.guards';
import { RateLimits } from '../security/rate-limits';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { AuthService } from './auth.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { RefreshSessionDto, RefreshTokenDto } from './dto/refresh-token.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles, RolesGuard } from './guards/roles.guard';
import { bearerToken } from './bearer-token';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly limits: RateLimits,
  ) {}

  @Post('register')
  @UseGuards(AuthRateGuard)
  @Header('Cache-Control', 'no-store')
  register(@Body() dto: RegisterDto) {
    return this.auth.register(dto);
  }

  @Post('login')
  @UseGuards(AuthRateGuard)
  @Header('Cache-Control', 'no-store')
  async login(@Body() dto: LoginDto, @Req() request: Request) {
    const refund = await this.limits.loginAttempt(dto.email, request);
    let wrongPassword = false;
    try {
      return await this.auth.login(dto);
    } catch (error) {
      wrongPassword = error instanceof UnauthorizedException;
      throw error;
    } finally {
      // Успішний вхід і збій не через пароль (503 БД) спробою не вважаються.
      if (!wrongPassword) await refund();
    }
  }

  // Без IP-ліміту входу: користувачі за одним NAT вичерпували б його звичайними оновленнями,
  // а 429 на refresh завершує сесію в браузері. Підібрати підписаний токен неможливо, повтор старого
  // refresh відкликає сесію, тож ліміт тут нічого не захищав.
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  refresh(@Body() dto: RefreshSessionDto) {
    return this.auth.refresh(dto.refreshToken, dto.rotate ?? true);
  }

  @Post('ws-token')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  webSocketToken(@Req() request: Request) {
    return this.auth.webSocketToken(bearerToken(request.headers.authorization) ?? '', (userId) =>
      this.limits.webSocketTicket(userId),
    );
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
