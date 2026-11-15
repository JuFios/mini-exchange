/**
 * Форма `Authorization`, яку приймає engine. Той самий вираз ключує ліміт читань у
 * `deploy/nginx/engine-lb.conf`: заголовок, який nginx не розпізнав би як токен, не обходить
 * ліміт, бо engine його відхиляє. passport-jwt ділить заголовок за будь-яким пробільним
 * символом JavaScript (зокрема U+00A0), а nginx — лише за пробілом і табуляцією.
 */
export const BEARER_HEADER =
  /^[ \t]*bearer[ \t]+[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.(?<signature>[A-Za-z0-9_-]{43})(?![A-Za-z0-9_.-])/i;

/** Токен із заголовка або `undefined`, якщо форма не збігається з `BEARER_HEADER`. */
export function bearerToken(header: string | undefined): string | undefined {
  const match = header === undefined ? null : BEARER_HEADER.exec(header);
  return match ? match[0].replace(/^[ \t]*bearer[ \t]+/i, '') : undefined;
}
