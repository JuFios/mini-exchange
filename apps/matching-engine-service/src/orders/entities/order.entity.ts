import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';

export type OrderSide = 'buy' | 'sell';
export type OrderStatus = 'open' | 'partially_filled' | 'filled' | 'cancelled';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  ownerId: string;

  @Column()
  instrument: string;

  @Column()
  side: OrderSide;

  @Column('numeric', { precision: 18, scale: 2 })
  price: string;

  @Column('numeric', { precision: 18, scale: 8 })
  quantity: string;

  @Column('numeric', { precision: 18, scale: 8 })
  remainingQuantity: string;

  @Column({ default: 'open' })
  status: OrderStatus;

  @Column({ type: 'timestamptz' })
  createdAt: Date;
}
