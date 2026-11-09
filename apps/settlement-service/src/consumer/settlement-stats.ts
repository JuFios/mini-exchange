import { Injectable } from '@nestjs/common';

/** Лічильники процесу; /metrics віддає їх у текстовому форматі Prometheus. */
@Injectable()
export class SettlementStats {
  readonly trades = { applied: 0, duplicate: 0, conflict: 0 };
  deadLettered = 0;
  trimmedPending = 0;
  transientFailures = 0;
  retriedFailures = 0;
}
