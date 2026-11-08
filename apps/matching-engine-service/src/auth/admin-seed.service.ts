import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { advisoryLocks, lockForTransaction } from '../database/advisory-lock';
import { User } from './entities/user.entity';

const seedLockTimeoutMs = 60_000;
const seedStatementTimeoutMs = seedLockTimeoutMs + 5_000;
const adminEmailCollision = 'ADMIN_EMAILS contains an address registered by a regular account';

@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const emails = this.config.getOrThrow<string[]>('ADMIN_EMAILS');
    const hashes = new Map<string, string>();
    // Хешування триває секунди, а сесія з відкритою транзакцією живе 2 с простою. Тому
    // транзакція лише каже, яких хешів бракує, а рахуються вони між спробами.
    for (;;) {
      const unhashed = await this.seed(emails, hashes);
      if (unhashed.length === 0) return;
      const password = this.config.getOrThrow<string>('ADMIN_PASSWORD');
      // Кожен акаунт отримує окрему сіль, навіть зі спільним початковим паролем.
      await Promise.all(
        unhashed.map(async (email) => hashes.set(email, await bcrypt.hash(password, 10))),
      );
    }
  }

  private seed(emails: string[], hashes: Map<string, string>): Promise<string[]> {
    return this.users.manager.transaction(async (manager) => {
      // Інакше очікування сусідньої репліки обірве загальний statement_timeout сесії.
      await manager.query("SELECT set_config('statement_timeout', $1, true)", [
        `${seedStatementTimeoutMs}ms`,
      ]);
      await lockForTransaction(manager, advisoryLocks.adminSeed, seedLockTimeoutMs);
      const users = manager.getRepository(User);
      const existing = await users
        .createQueryBuilder('account')
        .select(['account.email', 'account.adminSeeded'])
        .where('LOWER(account.email COLLATE "C") IN (:...emails)', { emails })
        .getMany();
      if (existing.some((user) => !user.adminSeeded)) {
        throw new Error(adminEmailCollision);
      }

      const seededEmails = new Set(existing.map((user) => user.email));
      const missing = emails.filter((email) => !seededEmails.has(email));
      const unhashed = missing.filter((email) => !hashes.has(email));
      if (missing.length === 0 || unhashed.length > 0) return unhashed;

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
      return [];
    });
  }
}
