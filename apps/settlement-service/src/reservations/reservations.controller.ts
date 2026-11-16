import { ModuleRef } from '@nestjs/core';
import { SettlementConsumer } from '../consumer/settlement-consumer.service';
import { EngineOutboxClient } from '../consumer/engine-outbox.client';
import {
  Body,
  ServiceUnavailableException,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { InternalTokenGuard } from '../security/internal-token.guard';
import { ReservationsService } from './reservations.service';
import { ReserveDto } from './reserve.dto';

@Controller('internal/reservations')
@UseGuards(InternalTokenGuard)
export class ReservationsController {
  private fundingUntil = 0;
  private funding?: Promise<void>;
  constructor(
    private readonly reservations: ReservationsService,
    private readonly outbox: EngineOutboxClient,
    private readonly modules: ModuleRef,
  ) {}

  @Post('ready')
  @HttpCode(200)
  async ready() {
    if (performance.now() < this.fundingUntil) return { status: 'ok' };
    if (!this.funding)
      this.funding = this.verifyFunding()
        .then(() => {
          this.fundingUntil = performance.now() + 1000;
        })
        .finally(() => {
          this.funding = undefined;
        });
    await this.funding;
    return { status: 'ok' };
  }

  private async verifyFunding(): Promise<void> {
    await this.outbox.page('ABC', '9223372036854775807');
    if (!(await this.modules.get(SettlementConsumer, { strict: false }).redisReady()))
      throw new ServiceUnavailableException('Розрахунок тимчасово недоступний');
  }

  @Post()
  async reserve(@Body() dto: ReserveDto) {
    await this.ready();
    const result = await this.reservations.reserve(dto);
    if (result.status === 'rejected') {
      throw new UnprocessableEntityException({
        code: 'INSUFFICIENT_FUNDS',
        message: 'Недостатньо коштів',
      });
    }
    return result;
  }

  @Post(':id/release')
  @HttpCode(200)
  async release(@Param('id', ParseUUIDPipe) id: string) {
    await this.outbox.assertCompensation(id);
    return this.reservations.release(id);
  }
}
