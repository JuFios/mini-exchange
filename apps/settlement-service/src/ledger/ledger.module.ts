import { Module } from '@nestjs/common';
import { LedgerWriter } from './ledger-writer';

@Module({ providers: [LedgerWriter], exports: [LedgerWriter] })
export class LedgerModule {}
