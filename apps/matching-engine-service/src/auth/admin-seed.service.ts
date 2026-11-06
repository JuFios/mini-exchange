import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import * as bcrypt from 'bcrypt';
import { Repository } from 'typeorm';
import { advisoryLocks, lockForTransaction } from '../database/advisory-lock';
import { User } from './entities/user.entity';

const seedLockTimeoutMs = 60_000;
const adminEmailCollision = 'ADMIN_EMAILS contains an address registered by a regular account';

@Injectable()
export class AdminSeedService implements OnApplicationBootstrap {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly config: ConfigService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    const emails = this.config.getOrThrow<string[]>('ADMIN_EMAILS');
    await this.users.manager.transaction(async (manager) => {
      await lockForTransaction(manager, advisoryLocks.adminSeed, seedLockTimeoutMs);
      const users = manager.getRepository(User);
      const existing = await users.createQueryBuilder('account')
        .select(['account.email', 'account.adminSeeded'])
        .where('LOWER(account.email COLLATE "C") IN (:...emails)', { emails })
        .getMany();
      if (existing.some((user) => !user.adminSeeded)) {
        throw new Error(adminEmailCollision);
      }

      const seededEmails = new Set(existing.map((user) => user.email));
      const missing = emails.filter((email) => !seededEmails.has(email));
      if (missing.length === 0) return;

      const password = this.config.getOrThrow<string>('ADMIN_PASSWORD');
      // Кожен акаунт отримує окрему сіль, навіть зі спільним початковим паролем.
      const accounts = await Promise.all(missing.map(async (email) => ({
        email,
        passwordHash: await bcrypt.hash(password, 10),
        adminSeeded: true,
      })));
      const { raw: inserted } = await users.createQueryBuilder().insert().values(accounts)
        .orIgnore().returning('email').execute();
      if (inserted.length !== accounts.length) throw new Error(adminEmailCollision);
    });
  }
}
