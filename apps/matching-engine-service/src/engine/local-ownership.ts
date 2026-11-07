import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// До розподіленого lease лише один процес має право вмикати worker.
@Injectable()
export class LocalOwnership {
  constructor(private readonly config: ConfigService) {}

  enabled(): boolean {
    return this.config.getOrThrow<boolean>('ENGINE_WORKER_ENABLED');
  }
}
