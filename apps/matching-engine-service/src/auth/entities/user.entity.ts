import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  email: string;

  @Column({ name: 'password_hash' })
  passwordHash: string;

  @Column({ name: 'admin_seeded', default: false })
  adminSeeded: boolean;

  @Column('uuid', { name: 'refresh_session_id', nullable: true })
  refreshSessionId: string | null;

  @Column('varchar', { name: 'refresh_token_hash', nullable: true })
  refreshTokenHash: string | null;

  @Column('varchar', { name: 'refresh_prev_hash', nullable: true })
  refreshPrevHash: string | null;

  @Column('timestamptz', { name: 'refresh_rotated_at', nullable: true })
  refreshRotatedAt: Date | null;
}
