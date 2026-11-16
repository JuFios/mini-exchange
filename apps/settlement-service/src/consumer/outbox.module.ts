import { Module } from '@nestjs/common';
import { EngineOutboxClient } from './engine-outbox.client';

@Module({ providers: [EngineOutboxClient], exports: [EngineOutboxClient] })
export class OutboxModule {}
