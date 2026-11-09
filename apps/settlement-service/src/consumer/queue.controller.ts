import { Controller, Get, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from '../security/admin-access.guard';
import { SettlementConsumer } from './settlement-consumer.service';

@Controller('admin/queue')
@UseGuards(AdminAccessGuard)
export class QueueController {
  constructor(private readonly consumer: SettlementConsumer) {}

  @Get()
  queue() {
    return this.consumer.queue();
  }
}
