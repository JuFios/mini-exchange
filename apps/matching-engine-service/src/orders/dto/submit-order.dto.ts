import { IsIn, IsNumber, IsPositive, IsString, ValidateIf } from 'class-validator';
import { OrderSide } from '../entities/order.entity';

export class SubmitOrderDto {
  @IsString()
  instrument: string;

  @IsIn(['buy', 'sell'])
  side: OrderSide;

  // Десятковий рядок передає точне значення; формат і межі перевіряє OrdersService.
  @ValidateIf((order: SubmitOrderDto) => typeof order.price !== 'string')
  @IsNumber()
  @IsPositive()
  price: number | string;

  @ValidateIf((order: SubmitOrderDto) => typeof order.quantity !== 'string')
  @IsNumber()
  @IsPositive()
  quantity: number | string;
}
