import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../security/internal-token.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { Roles, RolesGuard } from './guards/roles.guard';

@Controller('internal/auth')
@UseGuards(InternalTokenGuard, JwtAuthGuard)
export class InternalSessionController {
  @Get('session')
  @HttpCode(204)
  check(): void {}

  // Settlement не знає ADMIN_EMAILS і питає роль тут, щоб обидва сервіси знімали її одночасно.
  @Get('admin')
  @UseGuards(RolesGuard)
  @Roles(['admin'])
  @HttpCode(204)
  admin(): void {}
}
