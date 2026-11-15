import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis';
import type { Request, Response } from 'express';
import { ReplyError } from 'ioredis';
import { createHash } from 'node:crypto';
import { rateLimitBypassed, rateLimited } from '../observability/metrics';
import type { EngineEnv } from '../config/env.validation';
import { asciiLowerCase } from '../auth/auth.service';

class RateLimited extends HttpException {
  constructor(readonly retryAfter: number) {
    super('Забагато запитів', HttpStatus.TOO_MANY_REQUESTS);
  }
}

// Збій обмежувача з первинною помилкою: відмову Redis можна відрізнити від недоступного Redis.
class LimiterUnavailable extends ServiceUnavailableException {
  constructor(cause: unknown) {
    super('Обмежувач запитів тимчасово недоступний', { cause });
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

interface Taken {
  key: string;
  window: number;
}

type Scope =
  | 'auth'
  | 'login_email'
  | 'login_email_total'
  | 'ws_ticket'
  | 'orders_write'
  | 'public'
  | 'orders'
  | 'orders_minute';

// Невдалі входи рахуються у фіксованому вікні від першої спроби. Відхилена спроба не рахується
// й не подовжує вікно, на відміну від скрипта бібліотеки: інакше потік відхилених запитів з
// однієї адреси тримав би блок безстроково. Повертає {дозволено, мс до кінця, точний кінець вікна}.
const LOGIN_ATTEMPT = `local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
local ttl = redis.call('PTTL', KEYS[1])
if ttl <= 0 then
  redis.call('SET', KEYS[1], 1, 'PX', ARGV[1])
  return {1, tonumber(ARGV[1]), redis.call('PEXPIRETIME', KEYS[1])}
end
if hits >= tonumber(ARGV[2]) then return {0, ttl, 0} end
redis.call('INCR', KEYS[1])
return {1, ttl, redis.call('PEXPIRETIME', KEYS[1])}`;
// Точний кінець вікна визначає покоління ключа: залишковий TTL нового вікна теж зменшується
// й не дозволяє відрізнити його від старого. DECR не змінює строк завершення ключа.
const LOGIN_REFUND = `local expiresAt = redis.call('PEXPIRETIME', KEYS[1])
local hits = tonumber(redis.call('GET', KEYS[1]) or '0')
if expiresAt > 0 and expiresAt == tonumber(ARGV[1]) and hits > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0`;

@Injectable()
export class RateLimits implements OnModuleDestroy {
  private readonly storage: ThrottlerStorageRedisService;
  private readonly prefix: string;
  private readonly logger = new Logger(RateLimits.name);
  private bypassLoggedAt = 0;

  constructor(private readonly config: ConfigService<EngineEnv, true>) {
    this.prefix = 'exchange:limit:' + config.getOrThrow('DATABASE_NAME', { infer: true });
    this.storage = new ThrottlerStorageRedisService({
      host: config.getOrThrow('REDIS_HOST', { infer: true }),
      port: config.getOrThrow('REDIS_PORT', { infer: true }),
      username: config.getOrThrow('REDIS_USERNAME', { infer: true }),
      disableClientInfo: true,
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

  /**
   * Списує спробу входу до bcrypt і повертає функцію, яка її повертає. Контролер повертає
   * спробу після успішного входу чи помилки не через пароль, тож лічильники рахують лише невдалі
   * паролі. Списання до перевірки обмежує й паралельні спроби, які ще не дочекались bcrypt.
   * Строгий ліміт — на пару (email, IP): чужі невдалі спроби з іншої адреси не блокують власника.
   * Загальний ліміт на email — проти перебору з багатьох адрес.
   */
  async loginAttempt(email: string, request: Request): Promise<() => Promise<void>> {
    const account = asciiLowerCase(email);
    const ttl = this.config.getOrThrow('LOGIN_EMAIL_RATE_TTL_MS', { infer: true });
    const pair = await this.attempt(
      'login_email',
      `${account}\n${this.ip(request)}`,
      ttl,
      this.config.getOrThrow('LOGIN_EMAIL_RATE_LIMIT', { infer: true }),
    );
    let total: Taken;
    try {
      total = await this.attempt(
        'login_email_total',
        account,
        ttl,
        this.config.getOrThrow('LOGIN_EMAIL_TOTAL_RATE_LIMIT', { infer: true }),
      );
    } catch (error) {
      await this.refund(pair);
      throw error;
    }
    return async () => {
      await Promise.all([this.refund(pair), this.refund(total)]);
    };
  }

  publicRead(request: Request): Promise<void> {
    return this.check(
      'public',
      this.ip(request),
      this.config.getOrThrow('PUBLIC_RATE_TTL_MS', { infer: true }),
      this.config.getOrThrow('PUBLIC_RATE_LIMIT', { infer: true }),
    );
  }

  // На користувача, а не на адресу: клієнти за одним NAT і перепідключення після failover не
  // забирають квоту одне одного. Кожен сокет бере один тікет на handshake.
  async webSocketTicket(userId: string): Promise<void> {
    await this.attempt('ws_ticket', userId, 60_000, 120);
  }

  async orderWrite(userId: string, sessionId: string): Promise<void> {
    try {
      await this.attempt(
        'orders_write',
        `${userId.toLowerCase()}:${sessionId.toLowerCase()}`,
        this.config.getOrThrow('ORDER_WRITE_RATE_TTL_MS', { infer: true }),
        this.config.getOrThrow('ORDER_WRITE_RATE_LIMIT', { infer: true }),
      );
    } catch (error) {
      // Скасування й завершений повтор лишаються доступними без Redis. Нові заявки
      // перевіряють обов’язковий ліміт у intake; ingress також обмежує всі записи. Пропуск лише
      // для недоступного Redis: відповідь Redis (`NOPERM` після помилки в ACL тощо) означає
      // зламану конфігурацію, і тихо вимкнений ліміт її б сховав.
      if (!(error instanceof LimiterUnavailable) || error.cause instanceof ReplyError) throw error;
      rateLimitBypassed.inc({ scope: 'orders_write' });
      const now = Date.now();
      if (now - this.bypassLoggedAt >= 60_000) {
        this.bypassLoggedAt = now;
        this.logger.warn({ event: 'rate_limit.bypassed', scope: 'orders_write' });
      }
    }
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

  private async attempt(scope: Scope, identity: string, ttl: number, limit: number) {
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const key = `${this.prefix}:${scope}:${limit}:${ttl}:${identityHash}`;
    let result: unknown;
    try {
      result = await this.storage.redis.eval(LOGIN_ATTEMPT, 1, key, ttl, limit);
    } catch (error) {
      throw new LimiterUnavailable(error);
    }
    const [allowed, remaining, window] = result as [number, number, number];
    if (allowed === 1) return { key, window };
    rateLimited.inc({ scope });
    throw new RateLimited(Math.max(1, Math.ceil(remaining / 1000)));
  }

  // Повернення — best effort: якщо Redis недоступний, спроба лишиться списаною до кінця вікна.
  private async refund({ key, window }: Taken): Promise<void> {
    try {
      await this.storage.redis.eval(LOGIN_REFUND, 1, key, window);
    } catch {
      return;
    }
  }

  private async check(scope: Scope, identity: string, ttl: number, limit: number): Promise<void> {
    const identityHash = createHash('sha256').update(identity).digest('hex');
    const key = `${this.prefix}:${limit}:${ttl}:${identityHash}`;
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
