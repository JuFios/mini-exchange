import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import type { PostgresDriver } from 'typeorm/driver/postgres/PostgresDriver';
import type { Pool } from 'pg';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { User } from './entities/user.entity';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { passwordFitsBcrypt, passwordIsWellFormed } from './password';
import {
  hashRefreshToken,
  matchesRefreshHash,
  readRefreshClaims,
  RefreshClaims,
} from './refresh-session';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

const BCRYPT_COST = 10;

// Те саме, що `LOWER(... COLLATE "C")` у пошуку й індексі: змінюється лише латиниця ASCII.
const asciiLowerCase = (email: string) => email.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

@Injectable()
export class AuthService {
  // Хеш випадкового пароля з тією самою вартістю, що й у реєстрації. Рахується у фоні при створенні сервісу.
  private readonly absentPasswordHash = bcrypt.hash(randomUUID(), BCRYPT_COST);

  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
  ) {}

  async register(dto: RegisterDto): Promise<TokenPair> {
    // Варіанти адреси, що відрізняються регістром, — один акаунт. Нова адреса зберігається
    // нормалізованою, тож дві одночасні реєстрації варіантів упираються в `users_email_key`.
    const email = asciiLowerCase(dto.email);
    const taken = () => new ConflictException('Email вже зареєстровано');
    if (this.isAdminEmail(email) || (await this.byEmail(email).getExists())) throw taken();
    const passwordHash = await bcrypt.hash(dto.password, BCRYPT_COST);
    let user: User;
    try {
      user = await this.users.save(this.users.create({ email, passwordHash }));
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        error.driverError.code === '23505' &&
        error.driverError.constraint === 'users_email_key'
      ) {
        throw taken();
      }
      throw error;
    }
    return this.startSession(user);
  }

  async login(dto: LoginDto): Promise<TokenPair> {
    const user = await this.findByEmail(dto.email);
    // Невідомий email теж платить за bcrypt: час відповіді не розкриває, чи є акаунт.
    const hash = user?.passwordHash ?? (await this.absentPasswordHash);
    const valid = await bcrypt.compare(dto.password, hash);
    // Довший пароль збігся б із коротшим за спільним префіксом, а неспарений surrogate — із
    // U+FFFD. Порівняння вже витрачено, тож час відповіді від вмісту пароля не залежить.
    if (
      !user ||
      !valid ||
      !passwordFitsBcrypt(dto.password) ||
      !passwordIsWellFormed(dto.password)
    ) {
      throw new UnauthorizedException('Невірний email або пароль');
    }
    return this.startSession(user);
  }

  async refresh(token: string): Promise<TokenPair | { accessToken: string }> {
    const claims = readRefreshClaims(this.jwt, token, this.refreshSecret());
    const presentedHash = hashRefreshToken(token);
    let session = await this.readSession(claims);
    if (matchesRefreshHash(session.user.refreshTokenHash, presentedHash)) {
      const refreshToken = this.issueRefreshToken(claims.sub, claims.sid);
      const update = await this.users.update(
        { id: claims.sub, refreshSessionId: claims.sid, refreshTokenHash: presentedHash },
        {
          refreshTokenHash: hashRefreshToken(refreshToken),
          refreshPrevHash: presentedHash,
          refreshRotatedAt: () => 'clock_timestamp()',
        },
      );
      if (update.affected === 1)
        return { accessToken: this.issueAccessToken(session.user, claims.sid), refreshToken };

      // Після невдалого CAS читаємо стан, який записав паралельний запит.
      session = await this.readSession(claims);
    }
    if (session.withinGrace && matchesRefreshHash(session.user.refreshPrevHash, presentedHash)) {
      return { accessToken: this.issueAccessToken(session.user, claims.sid) };
    }

    await this.revokeSession(claims);
    throw new UnauthorizedException('Сесію оновлення відкликано');
  }

  async logout(token: string): Promise<void> {
    const claims = readRefreshClaims(this.jwt, token, this.refreshSecret());
    await this.revokeSession(claims);
  }

  isSessionActive(userId: string, sid: string): Promise<boolean> {
    return this.users.existsBy({ id: userId, refreshSessionId: sid });
  }

  /**
   * Ключі `userId:sid` активних сесій серед переданих; одним запитом для багатьох сокетів.
   * Завислий TCP PostgreSQL не відповідає й на statement_timeout. Тому скасування `signal`
   * знищує клієнта пулу: pg розриває сокет активного запиту, і з'єднання не повертається в пул.
   */
  async activeSessions(
    sessions: { userId: string; sid: string }[],
    signal: AbortSignal,
  ): Promise<Set<string>> {
    const ids = [...new Set(sessions.map(({ userId }) => userId.toLowerCase()))];
    if (ids.length === 0) return new Set();
    const pool = (this.users.manager.connection.driver as PostgresDriver).master as Pool;
    const client = await pool.connect();
    // На час видачі пул знімає свій обробник. Без власного розрив з'єднання став би
    // необробленою подією `error` і зупинив би процес; запит при цьому відхиляється сам.
    let broken: Error | undefined;
    const onError = (error: Error) => {
      broken ??= error;
    };
    client.on('error', onError);
    let released = false;
    // Зламане чи покинуте з'єднання знищується, і слухач лишається на ньому до кінця.
    const release = (destroy?: Error | boolean) => {
      if (released) return;
      released = true;
      if (!destroy) client.removeListener('error', onError);
      client.release(destroy);
    };
    if (signal.aborted) {
      // Пул видав з'єднання вже після дедлайну: воно справне, запит лише не потрібен.
      release();
      signal.throwIfAborted();
    }
    const abandon = () => release(true);
    signal.addEventListener('abort', abandon, { once: true });
    try {
      const { rows } = await client.query<{ id: string; refresh_session_id: string | null }>(
        'SELECT id, refresh_session_id FROM users WHERE id = ANY($1::uuid[])',
        [ids],
      );
      return new Set(
        rows.flatMap(({ id, refresh_session_id }) =>
          refresh_session_id ? [`${id}:${refresh_session_id}`.toLowerCase()] : [],
        ),
      );
    } finally {
      signal.removeEventListener('abort', abandon);
      release(broken);
    }
  }

  private async startSession(user: User): Promise<TokenPair> {
    const sid = randomUUID();
    const refreshToken = this.issueRefreshToken(user.id, sid);
    await this.users.update(user.id, {
      refreshSessionId: sid,
      refreshTokenHash: hashRefreshToken(refreshToken),
      refreshPrevHash: null,
      refreshRotatedAt: null,
    });
    return { accessToken: this.issueAccessToken(user, sid), refreshToken };
  }

  private issueAccessToken(user: User, sid: string): string {
    const roles = user.adminSeeded && this.isAdminEmail(user.email) ? ['admin'] : undefined;
    return this.jwt.sign(
      { sub: user.id, sid, email: user.email, typ: 'access', roles },
      {
        algorithm: 'HS256',
        secret: this.config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        expiresIn: this.config.getOrThrow<number>('JWT_ACCESS_TTL'),
        jwtid: randomUUID(),
      },
    );
  }

  private issueRefreshToken(sub: string, sid: string): string {
    return this.jwt.sign(
      { sub, sid, typ: 'refresh' },
      {
        algorithm: 'HS256',
        secret: this.refreshSecret(),
        expiresIn: this.config.getOrThrow<number>('JWT_REFRESH_TTL'),
        jwtid: randomUUID(),
      },
    );
  }

  private async readSession(claims: RefreshClaims) {
    const {
      entities: [user],
      raw: [state],
    } = await this.users
      .createQueryBuilder('account')
      .where({ id: claims.sub, refreshSessionId: claims.sid })
      .addSelect(
        "account.refreshRotatedAt >= statement_timestamp() - CAST(:graceMs AS integer) * interval '1 millisecond'",
        'within_grace',
      )
      .setParameter('graceMs', this.config.getOrThrow<number>('REFRESH_REUSE_GRACE_MS'))
      .getRawAndEntities<{ within_grace: boolean | null }>();
    if (!user?.refreshTokenHash) throw new UnauthorizedException('Сесію оновлення відкликано');
    return { user, withinGrace: state.within_grace === true };
  }

  private async revokeSession(claims: RefreshClaims): Promise<void> {
    await this.users.update(
      { id: claims.sub, refreshSessionId: claims.sid },
      {
        refreshSessionId: null,
        refreshTokenHash: null,
        refreshPrevHash: null,
        refreshRotatedAt: null,
      },
    );
  }

  // Людина вводить адресу в різному регістрі, а `users_email_key` його розрізняє. Пошук іде тим
  // самим виразом, що й індекс `users_email_lower_idx` і сідування адміна.
  private byEmail(email: string) {
    return this.users
      .createQueryBuilder('account')
      .where('LOWER(account.email COLLATE "C") = LOWER(:email COLLATE "C")', { email });
  }

  // Акаунти, що вже відрізняються лише регістром, лишаються: точний збіг має перевагу, а вхід без
  // нього до кількох акаунтів відхиляється, бо невідомо, чий це пароль.
  private async findByEmail(email: string): Promise<User | null> {
    const users = await this.byEmail(email).getMany();
    return users.find((user) => user.email === email) ?? (users.length === 1 ? users[0] : null);
  }

  private isAdminEmail(email: string): boolean {
    return this.config.getOrThrow<string[]>('ADMIN_EMAILS').includes(email.toLowerCase());
  }

  private refreshSecret(): string {
    return this.config.getOrThrow<string>('JWT_REFRESH_SECRET');
  }
}
