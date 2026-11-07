import fc from 'fast-check';
import { plainDecimal, topLevelNumberLexemes } from '../../src/orders/amount-lexemes';

describe('topLevelNumberLexemes', () => {
  it('returns the source text of numbers that JSON.parse would round', () => {
    const lexemes = topLevelNumberLexemes(
      ' {"price" : 1000000.00000000001 ,\n"quantity":1E-8, "x":-0} ',
    );
    expect(Object.fromEntries(lexemes)).toEqual({
      price: '1000000.00000000001',
      quantity: '1E-8',
      x: '-0',
    });
  });

  it('ignores nested values, arrays, strings and escaped keys', () => {
    const body =
      '{"a":{"price":1},"b":[1,{"price":2}],"c":"price\\":3","price\\"":4,"d":"x","price":5}';
    expect(Object.fromEntries(topLevelNumberLexemes(body))).toEqual({ 'price"': '4', price: '5' });
  });

  it('keeps the last duplicate, as JSON.parse does', () => {
    expect(topLevelNumberLexemes('{"price":1,"price":2.50}').get('price')).toBe('2.50');
  });

  it('handles long strings within the body size limit', () => {
    const body = `{"note":"${'a\\n'.repeat(40_000)}","price":1.5}`;
    expect(topLevelNumberLexemes(body).get('price')).toBe('1.5');
  });

  it('fails closed on text it cannot tokenize', () => {
    expect(() => topLevelNumberLexemes('{"price":1.5} garbage')).toThrow('Unexpected token');
  });

  it.each(['{}', '[]', '[1,2]', '"1"', '7'])('finds no members in %s', (body) => {
    expect(topLevelNumberLexemes(body).size).toBe(0);
  });

  it('matches JSON.parse for generated flat objects', () => {
    fc.assert(
      fc.property(
        fc.dictionary(
          fc.string({ maxLength: 6 }),
          fc.oneof(fc.integer(), fc.double({ noNaN: true, noDefaultInfinity: true })),
        ),
        (members) => {
          const body = JSON.stringify(members);
          const parsed = JSON.parse(body) as Record<string, number>;
          const lexemes = topLevelNumberLexemes(body);
          expect([...lexemes.keys()].sort()).toEqual(Object.keys(parsed).sort());
          for (const [key, lexeme] of lexemes) expect(Number(lexeme)).toBe(parsed[key]);
        },
      ),
      { seed: 20260611, numRuns: 500 },
    );
  });
});

describe('plainDecimal', () => {
  it.each([
    ['100', '100'],
    ['100.250', '100.250'],
    ['1e2', '100'],
    ['1E2', '100'],
    ['1.5e3', '1500'],
    ['1e-8', '0.00000001'],
    ['12345e-3', '12.345'],
    ['0.5e1', '5'],
    ['1.00000000000000001e0', '1.00000000000000001'],
    ['-1e1', '-10'],
    ['0e5', '0'],
  ])('expands %s to %s without rounding', (lexeme, expected) => {
    expect(plainDecimal(lexeme)).toBe(expected);
  });

  it('leaves absurd exponents for the strict parser to reject', () => {
    expect(plainDecimal('1e400')).toBe('1e400');
    expect(plainDecimal('1e-400')).toBe('1e-400');
  });

  it('agrees with BigInt arithmetic on generated decimals', () => {
    const scale = 60;
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.integer({ min: -30, max: 30 }),
        (mantissa, exponent) => {
          const [whole, fraction = ''] = plainDecimal(`${mantissa}e${exponent}`).split('.');
          const value = BigInt(whole + fraction) * 10n ** BigInt(scale - fraction.length);
          expect(value).toBe(mantissa * 10n ** BigInt(scale + exponent));
        },
      ),
      { seed: 20260611, numRuns: 300 },
    );
  });
});
