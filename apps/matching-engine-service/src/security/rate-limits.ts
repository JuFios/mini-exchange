import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Request, Response } from 'express';
import { createHash } from 'node:crypto';
import { rateLimited } from '../observability/metrics';
import type { EngineEnv } from '../config/env.validation';

class RateLimited extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Забагато запитів', HttpStatus.TOO_MANY_REQUESTS);
  }
}

@Catch(RateLimited)
export class RateLimitFilter implements ExceptionFilter {
  catch(error: RateLimited, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    response.setHeader('Retry-After', String(error.retryAfter));
    response
      .status(error.getStatus())
      .json({ statusCode: error.getStatus(), message: error.message });
  }
}

type Scope = 'auth' | 'login_email' | 'public' | 'orders' | 'orders_minute';

@Injectable()
export class RateLimits implements OnModuleDestroy {
  private readonly storage: ThrottlerStorageRedisService;
  private readonly prefix: string;

  constructor(private readonly config: ConfigService<EngineEnv, true>) {
    this.prefix = 'exchange:limit:' + config.getOrThrow('DATABASE_NAME', { infer: true });
    this.storage = new ThrottlerStorageRedisService({
      host: config.getOrThrow('REDIS_HOST', { infer: true }),
      port: config.getOrThrow('REDIS_PORT', { infer: true }),
      password: config.getOrThrow('REDIS_PASSWORD', { infer: true }),
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      connectTimeout: 1000,
      commandTimeout: 1000,
    });
    this.storage.redis.on('error', () => undefined);
  }

  auth(request: Request): Promise<void> {
    return this.check(
      'auth',
      this.ip(request),
      this.config.getOrThrow('AUTH_RATE_TTL_MS', { infer: true }),
      this.config.getOrThrow('AUTH_RATE_LIMIT', { infer: true }),
    );
  }

  loginEmail(email: string): Promise<void> {
    return this.check(
      'login_email',
      email.trim().toLowerCase(),
      this.config.getOrThrow('LOGIN_EMAIL_RATE_TTL_MS', { infer: true }),
      this.config.getOrThrow('LOGIN_EMAIL_RATE_LIMIT', { infer: true }),
    );
  }

  publicRead(request: Request): Promise<void> {
    return this.check(
      'public',
      this.ip(request),
      this.config.getOrThrow('PUBLIC_RATE_TTL_MS', { infer: true }),
      this.config.getOrThrow('PUBLIC_RATE_LIMIT', { infer: true }),
    );
  }

  async order(userId: string): Promise<void> {
    await this.check(
      'orders',
      userId,
      this.config.getOrThrow('ORDER_RATE_TTL_MS', { infer: true }),
      this.config.getOrThrow('ORDER_RATE_LIMIT', { infer: true }),
    );
    await this.check(
      'orders_minute',
      userId,
      60_000,
      this.config.getOrThrow('ORDER_RATE_LIMIT_MIN', { infer: true }),
    );
  }

  onModuleDestroy(): void {
    this.storage.onModuleDestroy();
  }

  private ip(request: Request): string {
    return (request.ip ?? request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
  }

  private async check(scope: Scope, identity: string, ttl: number, limit: number): Promise<void> {
    const key = this.prefix + ':' + createHash('sha256').update(identity).digest('hex');
    let retryAfter: number;
    try {
      const hit = await this.storage.increment(key, ttl, limit, ttl, scope);
      if (!hit.isBlocked) return;
      retryAfter = Math.max(1, hit.timeToBlockExpire);
    } catch {
      throw new ServiceUnavailableException('Обмежувач запитів тимчасово недоступний');
    }
    rateLimited.inc({ scope });
    throw new RateLimited(retryAfter);
  }
}
