import { Module } from '@nestjs/common';
import { LedgerWriter } from './ledger-writer';
import { WalletReader } from './wallet-reader';

@Module({ providers: [LedgerWriter, WalletReader], exports: [LedgerWriter, WalletReader] })
export class LedgerModule {}
