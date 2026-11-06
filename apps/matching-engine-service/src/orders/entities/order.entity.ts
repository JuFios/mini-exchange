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

  @Column('numeric', { name: 'filled_quantity', precision: 18, scale: 8, default: 0, select: false })
  filledQuantity?: string;

  @Column('bigint', { name: 'priority_seq', nullable: true, select: false })
  prioritySeq?: string | null;

  @Column('varchar', { name: 'cancel_reason', nullable: true, select: false })
  cancelReason?: string | null;

  @Column('integer', { default: 0, select: false })
  version?: number;

  @Column('timestamptz', { name: 'updated_at', default: () => 'now()', select: false })
  updatedAt?: Date;
}
