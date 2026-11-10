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
  // Поле без maxLength не обрізає вставлене значення мовчки, тож довге просто відхиляється.
  if (value.length > 32) return;
  const match = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]+))?$/.exec(value);
  if (!match || match[0] !== value || (match[2]?.length ?? 0) > scale) return;
  return BigInt(match[1] + (match[2] ?? '').padEnd(scale, '0'));
}

/** Пробіли по краях і кома замість крапки — звичні помилки введення, а не хибні дані. */
export const normalizeAmount = (value: string) => value.trim().replace(',', '.');

export function fixedAmount(value: string, scale: number) {
  const [whole, fraction = ''] = value.split('.');
  return whole + '.' + fraction.padEnd(scale, '0');
}

/** Сума заявки для підказки: ціна × кількість без втрати знаків. */
export function orderTotal(price: string, quantity: string) {
  const unitPrice = units(normalizeAmount(price), 2);
  const unitQuantity = units(normalizeAmount(quantity), 8);
  if (!unitPrice || !unitQuantity) return;
  const digits = (unitPrice * unitQuantity).toString().padStart(11, '0');
  return digits.slice(0, -10) + '.' + digits.slice(-10);
}

export async function submitValidatedOrder<T>(
  input: OrderInput,
  limits: AmountLimits,
  send: (input: OrderInput) => Promise<T>,
): Promise<{ errors: AmountErrors; result?: T }> {
  const errors: AmountErrors = {};
  const raw = { price: normalizeAmount(input.price), quantity: normalizeAmount(input.quantity) };
  const price = units(raw.price, 2);
  const quantity = units(raw.quantity, 8);
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
    errors.price = raw.price
      ? `Від ${limits.tickSize} до ${limits.maxPrice}, крок ${limits.tickSize}`
      : 'Вкажіть ціну';
  if (
    !quantity ||
    !lot ||
    min === undefined ||
    max === undefined ||
    quantity < min ||
    quantity > max ||
    quantity % lot !== 0n
  )
    errors.quantity = raw.quantity
      ? `Від ${limits.minQty} до ${limits.maxQty}, крок ${limits.lotSize}`
      : 'Вкажіть кількість';
  if (errors.price || errors.quantity) return { errors };
  return {
    errors,
    result: await send({
      instrument: input.instrument,
      side: input.side,
      price: fixedAmount(raw.price, 2),
      quantity: fixedAmount(raw.quantity, 8),
    }),
  };
}
