// Вкладки одного браузера ділять cookie, а приватний сокет вкладки прив'язаний до користувача,
// якого він бачив при підключенні. Модуль тримає цю прив'язку й сповіщає інші вкладки про вхід і вихід.
const SIGNAL_KEY = 'exchange.session';
let user: string | undefined;

export const SESSION_HEADER = 'x-session-user';
// Запит, який клієнт може обірвати, просить middleware не оновлювати сесію під час нього.
export const DEFER_REFRESH_HEADER = 'x-defer-refresh';
export const bindSession = (id: string | undefined) => {
  user = id;
};
export const boundSession = () => user;

export function announceSessionChange() {
  try {
    localStorage.setItem(SIGNAL_KEY, String(Date.now()));
  } catch {
    // Без сховища інші вкладки дізнаються про зміну з першої відповіді 409.
  }
}

export function watchSessionChange(onChange: () => void) {
  const handler = (event: StorageEvent) => {
    if (event.key === SIGNAL_KEY) onChange();
  };
  window.addEventListener('storage', handler);
  return () => window.removeEventListener('storage', handler);
}
