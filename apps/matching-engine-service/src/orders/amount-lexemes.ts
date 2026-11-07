const TOKEN =
  /\s*(?:("(?:[^"\\]|\\.)*")|(-?[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)|([{}[\],:])|(?:true|false|null))/y;
const NUMBER = /^(-?)([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/;
// Розгортання експоненти не повинно роздувати рядок: довші значення все одно відхиляє парсер.
const MAX_EXPONENT = 64;

/**
 * Текст JSON-чисел верхнього об'єкта за ім'ям поля. `JSON.parse` уже округлив їх
 * до `number`, тож лише вихідний запис показує, чи не втрачено знаки.
 * Тіло вже розібрано body-parser, тому тут лише проста лексична прохідка.
 */
export function topLevelNumberLexemes(body: string): Map<string, string> {
  const found = new Map<string, string>();
  let depth = 0;
  let key: string | undefined;
  let afterColon = false;
  let previousString: string | undefined;

  TOKEN.lastIndex = 0;
  let end = 0;
  for (let token = TOKEN.exec(body); token; token = TOKEN.exec(body)) {
    end = TOKEN.lastIndex;
    const [, text, number, punctuation] = token;
    if (number !== undefined && depth === 1 && afterColon && key !== undefined) {
      found.set(key, number);
    }
    afterColon = false;
    if (punctuation === '{' || punctuation === '[') depth++;
    else if (punctuation === '}' || punctuation === ']') depth--;
    else if (punctuation === ':' && depth === 1 && previousString !== undefined) {
      key = previousString;
      afterColon = true;
    }
    previousString = text !== undefined && depth === 1 ? (JSON.parse(text) as string) : undefined;
  }
  // Нерозпізнаний залишок не пропускаємо мовчки: інакше поле лишилось би без перевірки.
  if (body.slice(end).trim() !== '') throw new Error('Unexpected token in JSON body');
  return found;
}

/**
 * Точний десятковий запис JSON-числа без експоненти. Нічого не округлює:
 * лишні знаки залишаються в рядку, і строгий парсер їх відхилить.
 */
export function plainDecimal(lexeme: string): string {
  const parts = NUMBER.exec(lexeme);
  if (!parts) return lexeme;
  const [, sign, whole, fraction = '', exponent = '0'] = parts;
  const shift = Number(exponent);
  if (Math.abs(shift) > MAX_EXPONENT) return lexeme;

  const digits = whole + fraction;
  const point = whole.length + shift;
  let integer: string;
  let decimals: string;
  if (point <= 0) {
    integer = '0';
    decimals = '0'.repeat(-point) + digits;
  } else if (point >= digits.length) {
    integer = digits + '0'.repeat(point - digits.length);
    decimals = '';
  } else {
    integer = digits.slice(0, point);
    decimals = digits.slice(point);
  }
  integer = integer.replace(/^0+(?=[0-9])/, '');
  return `${sign}${integer}${decimals ? `.${decimals}` : ''}`;
}
