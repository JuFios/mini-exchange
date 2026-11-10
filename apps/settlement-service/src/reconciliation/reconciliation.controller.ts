import { Controller, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from '../security/admin-access.guard';
import { ReconciliationQuery, toPeriod } from './reconciliation-query';
import { ReconciliationService } from './reconciliation.service';

@Controller('admin/reconciliation')
@UseGuards(AdminAccessGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post()
  @HttpCode(200)
  run(@Query() query: ReconciliationQuery) {
    return this.reconciliation.run(toPeriod(query));
  }
}
