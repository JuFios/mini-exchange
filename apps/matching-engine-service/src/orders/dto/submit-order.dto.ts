import { IsIn, IsNotEmpty, IsString, registerDecorator } from 'class-validator';
import { DecimalError, parsePrice, parseQuantity } from '../../matching/decimal';
import { OrderSide } from '../entities/order.entity';

function IsDecimalString(parse: (value: string) => bigint, message: string): PropertyDecorator {
  return (target, property) => {
    registerDecorator({
      name: 'isDecimalString',
      target: target.constructor,
      propertyName: String(property),
      options: { message },
      validator: {
        validate(value: unknown): boolean {
          // Точний запис JSON-числа відновлює контролер перед перевіркою в сервісі.
          if (typeof value === 'number') return Number.isFinite(value) && value > 0;
          if (typeof value !== 'string') return false;
          try {
            parse(value);
            return true;
          } catch (error) {
            if (error instanceof DecimalError) return false;
            throw error;
          }
        },
      },
    });
  };
}

export class SubmitOrderDto {
  @IsString({ message: 'Інструмент має бути рядком' })
  @IsNotEmpty({ message: 'Вкажіть інструмент' })
  instrument: string;

  @IsIn(['buy', 'sell'], { message: 'Напрям заявки має бути buy або sell' })
  side: OrderSide;

  @IsDecimalString(parsePrice, 'Некоректна ціна')
  price: number | string;

  @IsDecimalString(parseQuantity, 'Некоректна кількість')
  quantity: number | string;
}
