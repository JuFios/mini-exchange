import { ASSETS } from '../ledger/amount';

export const GROUP = 'settlement';
export const DEAD_LETTER_STREAM = 'exchange:dlq';

// Ключ стріму на інструмент; інструмент збігається з базовим активом (див. TradesService).
export const settlementStream = (instrument: string): string =>
  `exchange:settlement:{${instrument}}`;

export const SETTLEMENT_STREAMS = ASSETS.filter((asset) => asset !== 'USD').map(settlementStream);
