import { Controller, Get, HttpCode, UseGuards } from '@nestjs/common';
import { InternalTokenGuard } from '../security/internal-token.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';

@Controller('internal/auth/session')
@UseGuards(InternalTokenGuard, JwtAuthGuard)
export class InternalSessionController {
  @Get()
  @HttpCode(204)
  check(): void {}
}
