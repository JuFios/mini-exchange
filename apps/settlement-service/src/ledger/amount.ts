export const ASSET_SCALES = { ABC: 8, USD: 10, XYZ: 8 } as const;
export type Asset = keyof typeof ASSET_SCALES;
export const ASSETS = Object.keys(ASSET_SCALES) as Asset[];
export const MAX_PRICE_TICKS = 100_000_000n;
export const MAX_QUANTITY_LOTS = 100_000_000_000_000n;
export const MAX_AMOUNT = 10n ** 38n - 1n;

export function parseAmount(value: string, scale: number): bigint {
  const match = /^(0|[1-9][0-9]{0,37})(?:\.([0-9]+))?$/.exec(value);
  if (!match || match[0] !== value || (match[2]?.length ?? 0) > scale)
    throw new Error('Invalid amount');
  const amount = BigInt(match[1] + (match[2] ?? '').padEnd(scale, '0'));
  if (amount > MAX_AMOUNT) throw new Error('Amount is out of range');
  return amount;
}

export function formatAmount(value: bigint, scale: number): string {
  const digits = value.toString().padStart(scale + 1, '0');
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}
