export interface AmountLimits {
  tickSize: string;
  lotSize: string;
  minQty: string;
  maxQty: string;
  maxPrice: string;
}

export interface OrderInput {
  instrument: string;
  side: 'buy' | 'sell';
  price: string;
  quantity: string;
}

export type AmountErrors = Partial<Record<'price' | 'quantity', string>>;

function units(value: string, scale: number) {
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]+))?$/.exec(value);
  if (!match || match[0] !== value || (match[2]?.length ?? 0) > scale) return;
  return BigInt(match[1] + (match[2] ?? '').padEnd(scale, '0'));
}

export function fixedAmount(value: string, scale: number) {
  const [whole, fraction = ''] = value.split('.');
  return whole + '.' + fraction.padEnd(scale, '0');
}

export async function submitValidatedOrder<T>(
  input: OrderInput,
  limits: AmountLimits,
  send: (input: OrderInput) => Promise<T>,
): Promise<{ errors: AmountErrors; result?: T }> {
  const errors: AmountErrors = {};
  const price = units(input.price, 2);
  const quantity = units(input.quantity, 8);
  const tick = units(limits.tickSize, 2);
  const lot = units(limits.lotSize, 8);
  const min = units(limits.minQty, 8);
  const max = units(limits.maxQty, 8);
  const maxPrice = units(limits.maxPrice, 2);
  if (
    !price ||
    !tick ||
    maxPrice === undefined ||
    price < tick ||
    price > maxPrice ||
    price % tick !== 0n
  )
    errors.price = `Від ${limits.tickSize} до ${limits.maxPrice}, крок ${limits.tickSize}`;
  if (
    !quantity ||
    !lot ||
    min === undefined ||
    max === undefined ||
    quantity < min ||
    quantity > max ||
    quantity % lot !== 0n
  )
    errors.quantity = `Від ${limits.minQty} до ${limits.maxQty}, крок ${limits.lotSize}`;
  if (errors.price || errors.quantity) return { errors };
  return {
    errors,
    result: await send({
      instrument: input.instrument,
      side: input.side,
      price: fixedAmount(input.price, 2),
      quantity: fixedAmount(input.quantity, 8),
    }),
  };
}
