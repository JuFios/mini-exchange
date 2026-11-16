import type { Response } from 'express';
import { Controller, HttpCode, Post, Query, Res, UseGuards } from '@nestjs/common';
import { AdminAccessGuard } from '../security/admin-access.guard';
import { ReconciliationQuery, toPeriod } from './reconciliation-query';
import { ReconciliationService } from './reconciliation.service';

@Controller('admin/reconciliation')
@UseGuards(AdminAccessGuard)
export class ReconciliationController {
  constructor(private readonly reconciliation: ReconciliationService) {}

  @Post()
  @HttpCode(200)
  async run(@Query() query: ReconciliationQuery, @Res({ passthrough: true }) response: Response) {
    const controller = new AbortController();
    const cancel = () => {
      if (!response.writableEnded) controller.abort();
    };
    response.once('close', cancel);
    try {
      return await this.reconciliation.run(toPeriod(query), controller.signal);
    } finally {
      response.removeListener('close', cancel);
    }
  }
}
