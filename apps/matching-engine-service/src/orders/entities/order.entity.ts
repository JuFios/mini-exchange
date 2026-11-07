import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'pending' | 'open' | 'partially_filled' | 'filled' | 'cancelled';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column('uuid', { name: 'owner_id' })
  ownerId: string;

  @Column()
  instrument: string;

  @Column()
  side: OrderSide;

  @Column('numeric', { precision: 18, scale: 2 })
  price: string;

  @Column('numeric', { precision: 18, scale: 8 })
  quantity: string;

  @Column('numeric', { name: 'remaining_quantity', precision: 18, scale: 8 })
  remainingQuantity: string;

  @Column({ default: 'open' })
  status: OrderStatus;

  @Column({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column('numeric', { name: 'filled_quantity', precision: 18, scale: 8, default: 0 })
  filledQuantity?: string;

  @Column('bigint', { name: 'priority_seq', nullable: true })
  prioritySeq?: string | null;

  @Column('varchar', { name: 'cancel_reason', nullable: true })
  cancelReason?: string | null;

  @Column('integer', { default: 0 })
  version?: number;

  @Column('timestamptz', { name: 'updated_at', default: () => 'now()' })
  updatedAt?: Date;
}
