export class DecimalError extends Error {
  constructor(field: string, scale: number) {
    super(`${field} must be positive, at most 1000000, with at most ${scale} fractional digits`);
    this.name = 'DecimalError';
  }
}

const PRICE_SCALE = 2;
const QUANTITY_SCALE = 8;
const MAX_WHOLE = 1_000_000n;
const DECIMAL = /^(0|[1-9][0-9]{0,6})(?:\.([0-9]+))?$/;

function decimalText(value: string | number, scale: number): string {
  const text = String(value);
  if (typeof value === 'number') {
    // JSON numbers at the minimum lot size stringify with a negative exponent.
    // Expand their shortest decimal representation without rounding.
    const scientific = /^([1-9])(?:\.([0-9]+))?e-([0-9]+)$/.exec(text);
    if (scientific) {
      const [, whole, fraction = '', exponent] = scientific;
      const places = Number(exponent);
      if (places + fraction.length <= scale) {
        return `0.${'0'.repeat(places - 1)}${whole}${fraction}`;
      }
    }
  }
  return text;
}

function parse(value: string | number, scale: number, field: string): bigint {
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw new DecimalError(field, scale);
  }
  const text = decimalText(value, scale);
  if (text.length > 8 + scale) throw new DecimalError(field, scale);

  const parts = DECIMAL.exec(text);
  if (!parts || parts[0] !== text || (parts[2]?.length ?? 0) > scale) {
    throw new DecimalError(field, scale);
  }
  const units = BigInt(parts[1] + (parts[2] ?? '').padEnd(scale, '0'));
  if (units === 0n || units > MAX_WHOLE * 10n ** BigInt(scale)) {
    throw new DecimalError(field, scale);
  }
  return units;
}

function format(units: bigint, scale: number): string {
  const sign = units < 0n ? '-' : '';
  const digits = (units < 0n ? -units : units).toString().padStart(scale + 1, '0');
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

export const parsePrice = (value: string | number): bigint => parse(value, PRICE_SCALE, 'price');
export const parseQuantity = (value: string | number): bigint => parse(value, QUANTITY_SCALE, 'quantity');
export const formatPrice = (ticks: bigint): string => format(ticks, PRICE_SCALE);
export const formatQuantity = (lots: bigint): string => format(lots, QUANTITY_SCALE);

export const ORDER_AMOUNT_LIMITS = {
  tickSize: formatPrice(1n),
  lotSize: formatQuantity(1n),
  minQty: formatQuantity(1n),
  maxQty: formatQuantity(MAX_WHOLE * 10n ** BigInt(QUANTITY_SCALE)),
  maxPrice: formatPrice(MAX_WHOLE * 10n ** BigInt(PRICE_SCALE)),
};
