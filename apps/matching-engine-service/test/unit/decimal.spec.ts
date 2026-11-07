import * as fc from 'fast-check';
import {
  DecimalError,
  formatPrice,
  formatQuantity,
  parsePrice,
  parseQuantity,
} from '../../src/matching/decimal';

describe('fixed-scale decimal amounts', () => {
  it.each([
    ['0.01', 1n],
    ['1000000.00', 100_000_000n],
    [0.1, 10n],
  ])('parses price %s without floating-point arithmetic', (value, ticks) => {
    expect(parsePrice(value)).toBe(ticks);
  });

  it.each([
    '100.005',
    100.005,
    '1e2',
    1e21,
    '-1',
    '0',
    '1000000.01',
    ' 1',
    '1 ',
    '1\n',
    '+1',
    '-0',
    '01.00',
    '.5',
    '5.',
    NaN,
    Infinity,
    0.1 + 0.2,
    '1'.repeat(100_000),
  ])('rejects an invalid price (case %#)', (value) => {
    expect(() => parsePrice(value)).toThrow(DecimalError);
  });

  it.each([
    ['0.00000001', 1n],
    ['1000000', 100_000_000_000_000n],
    [1e-8, 1n],
    [1.1e-7, 11n],
  ])('parses quantity %s at lot precision', (value, lots) => {
    expect(parseQuantity(value)).toBe(lots);
  });

  it.each(['0.123456789', '0.000000001', 1e-9, '1000000.00000001', '1e-8', 0.1 + 0.2])(
    'rejects invalid quantity %s',
    (value) => expect(() => parseQuantity(value)).toThrow(DecimalError),
  );

  it('round-trips 10000 valid decimal strings to their canonical representation', () => {
    const representations = (scale: number) => {
      const factor = 10n ** BigInt(scale);
      return fc
        .tuple(fc.bigInt({ min: 1n, max: 1_000_000n * factor }), fc.boolean())
        .map(([units, trim]) => {
          const whole = (units / factor).toString();
          const fraction = (units % factor).toString().padStart(scale, '0');
          const canonical = `${whole}.${fraction}`;
          const short = fraction.replace(/0+$/, '');
          return {
            scale,
            canonical,
            text: trim ? (short ? `${whole}.${short}` : whole) : canonical,
          };
        });
    };

    fc.assert(
      fc.property(
        fc.oneof(representations(2), representations(8)),
        ({ scale, text, canonical }) => {
          const value =
            scale === 2 ? formatPrice(parsePrice(text)) : formatQuantity(parseQuantity(text));
          expect(value).toBe(canonical);
        },
      ),
      { numRuns: 10_000, seed: 13241 },
    );
  });

  it('preserves precision in quote units at and near both maxima', () => {
    expect(parsePrice('1000000.00') * parseQuantity('1000000.00000000')).toBe(
      10_000_000_000_000_000_000_000n,
    );
    expect(parsePrice('999999.99') * parseQuantity('999999.99999999')).toBe(
      9_999_999_899_999_900_000_001n,
    );
  });
});
