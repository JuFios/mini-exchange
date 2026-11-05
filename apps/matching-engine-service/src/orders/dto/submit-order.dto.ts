import { IsIn, IsNumber, IsPositive, IsString } from 'class-validator';
import { OrderSide } from '../entities/order.entity';

export class SubmitOrderDto {
  @IsString()
  instrument: string;

  @IsIn(['buy', 'sell'])
  side: OrderSide;

  @IsNumber()
  @IsPositive()
  price: number;

  @IsNumber()
  @IsPositive()
  quantity: number;
}
