import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { Roles, RolesGuard } from '../auth/guards/roles.guard';
import { ArmChaosDto, ChaosHooks } from './chaos-hooks';

@Controller('admin/chaos')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(['admin'])
export class ChaosController {
  constructor(private readonly hooks: ChaosHooks) {}
  @Post() arm(@Body() input: ArmChaosDto) {
    return this.hooks.arm(input);
  }
}
