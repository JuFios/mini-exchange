// Без імпортів: модуль потрібен і клієнтському компоненту, і тестам.
/**
 * Адреса без позначки `recovered`, якщо вона є. Позначка діє лише на одне відкриття після
 * оновлення сесії: інакше пізніший 401 (токен сплив між middleware і перевіркою) одразу вів би
 * на вхід, а новий вхід відкликає сесію в інших вкладках.
 */
export function withoutRecoveredMarker(href: string): string | undefined {
  const url = new URL(href);
  if (!url.searchParams.has('recovered')) return;
  url.searchParams.delete('recovered');
  return url.pathname + url.search + url.hash;
}
