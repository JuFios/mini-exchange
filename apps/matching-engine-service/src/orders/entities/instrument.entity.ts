import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity('instruments')
export class Instrument {
  @PrimaryColumn('varchar')
  symbol: string;

  @Column({ name: 'base_asset' })
  baseAsset: string;

  @Column({ name: 'quote_asset' })
  quoteAsset: string;

  @Column('numeric', { name: 'tick_size', precision: 18, scale: 2 })
  tickSize: string;

  @Column('numeric', { name: 'lot_size', precision: 18, scale: 8 })
  lotSize: string;

  @Column('numeric', { name: 'min_qty', precision: 18, scale: 8 })
  minQty: string;

  @Column('numeric', { name: 'max_qty', precision: 18, scale: 8 })
  maxQty: string;

  @Column('numeric', { name: 'max_price', precision: 18, scale: 2 })
  maxPrice: string;

  @Column('bigint', { name: 'next_seq', default: 0, select: false })
  nextSeq: string;
}
