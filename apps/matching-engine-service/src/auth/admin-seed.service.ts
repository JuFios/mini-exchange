import { Injectable, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { advisoryLocks, lockForTransaction } from '../database/advisory-lock';
import { User } from './entities/user.entity';

const seedLockTimeoutMs = 60_000;
const seedStatementTimeoutMs = seedLockTimeoutMs + 5_000;
const adminEmailCollision = 'ADMIN_EMAILS contains an address registered by a regular account';

interface SeedWork {
  unchecked: Pick<User, 'email' | 'passwordHash'>[];
  unhashed: string[];
}

@Injectable()
export class AdminSeedService implements OnModuleInit {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    const emails = this.config.getOrThrow<string[]>('ADMIN_EMAILS');
    const hashes = new Map<string, string>();
    const verified =
      this.config.getOrThrow<string>('DEPLOYMENT_MODE') === 'remote'
        ? new Map<string, string>()
        : undefined;
    // Bcrypt працює поза транзакцією. Seed вставляє рядки лише після перевірки наявних хешів.
    for (;;) {
      const { unchecked, unhashed } = await this.seed(emails, hashes, verified);
      if (unchecked.length === 0 && unhashed.length === 0) return;
      const password = this.config.getOrThrow<string>('ADMIN_PASSWORD');
      await Promise.all(
        unchecked.map(async ({ email, passwordHash }) => {
          if (!(await bcrypt.compare(password, passwordHash))) {
            throw new Error(
              'Remote seeded admin credentials do not match ADMIN_PASSWORD; use a fresh remote database or rotate the stored password first',
            );
          }
          verified?.set(email, passwordHash);
        }),
      );
      // Кожен акаунт отримує окрему сіль, навіть зі спільним початковим паролем.
      await Promise.all(
        unhashed.map(async (email) => hashes.set(email, await bcrypt.hash(password, 10))),
      );
    }
  }

  private seed(
    emails: string[],
    hashes: ReadonlyMap<string, string>,
    verified?: ReadonlyMap<string, string>,
  ): Promise<SeedWork> {
    return this.users.manager.transaction(async (manager) => {
      // Інакше очікування сусідньої репліки обірве загальний statement_timeout сесії.
      await manager.query("SELECT set_config('statement_timeout', $1, true)", [
        `${seedStatementTimeoutMs}ms`,
      ]);
      await lockForTransaction(manager, advisoryLocks.adminSeed, seedLockTimeoutMs);
      const users = manager.getRepository(User);
      const query = users
        .createQueryBuilder('account')
        .select(['account.email', 'account.adminSeeded'])
        .where('LOWER(account.email COLLATE "C") IN (:...emails)', { emails });
      // Повторно звіряємо значення хешу під lock, якщо паралельний startup чи ротація його змінили.
      if (verified) query.addSelect('account.passwordHash').setLock('pessimistic_read');
      const existing = await query.getMany();
      if (existing.some((user) => !user.adminSeeded)) {
        throw new Error(adminEmailCollision);
      }

      const seededEmails = new Set(existing.map((user) => user.email));
      const missing = emails.filter((email) => !seededEmails.has(email));
      const unhashed = missing.filter((email) => !hashes.has(email));
      const unchecked = verified
        ? existing.filter(({ email, passwordHash }) => verified.get(email) !== passwordHash)
        : [];
      if (missing.length === 0 || unchecked.length > 0 || unhashed.length > 0)
        return { unchecked, unhashed };

      const accounts = missing.map((email) => ({
        email,
        passwordHash: hashes.get(email)!,
        adminSeeded: true,
      }));
      const { raw: inserted } = await users
        .createQueryBuilder()
        .insert()
        .values(accounts)
        .orIgnore()
        .returning('email')
        .execute();
      if (inserted.length !== accounts.length) throw new Error(adminEmailCollision);
      return { unchecked, unhashed };
    });
  }
}
