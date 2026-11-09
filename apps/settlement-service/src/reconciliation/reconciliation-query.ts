import { IsIn, IsOptional, Matches, validateSync } from 'class-validator';
import { BadRequestException } from '@nestjs/common';
import { ASSETS } from '../ledger/amount';
import type { Period } from './engine-trades.client';

// Мітка виконання зберігається з точністю до мілісекунди, тож межі періоду теж.
const ISO_MILLISECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EPOCH = '1970-01-01T00:00:00.000Z';

export class ReconciliationQuery {
  @IsOptional()
  @Matches(ISO_MILLISECONDS)
  from?: string;

  @IsOptional()
  @Matches(ISO_MILLISECONDS)
  to?: string;

  @IsOptional()
  @IsIn(ASSETS.filter((asset) => asset !== 'USD'))
  instrument?: string;
}

export function toPeriod(query: ReconciliationQuery): Period {
  // HTTP перевіряє ValidationPipe; CLI передає сюди сирі аргументи.
  if (validateSync(Object.assign(new ReconciliationQuery(), query)).length)
    throw new BadRequestException('Некоректні параметри звірки');
  const from = query.from ?? EPOCH;
  const to = query.to ?? new Date().toISOString();
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)) || from >= to)
    throw new BadRequestException('Некоректний період звірки');
  return { from, to, ...(query.instrument && { instrument: query.instrument }) };
}
