import { type Clock, realClock } from './book-session';

// Як часто звіряти гаманці з REST, поки приватний канал підключений.
export const WALLET_REFRESH_MS = 10_000;
// Пауза після події заявки: пачка подій дає одне читання, а не по одному на кожну.
export const WALLET_EVENT_DELAY_MS = 500;
// Скільки чекати на відповідь, перш ніж обірвати читання й чекати наступної звірки.
export const WALLET_TIMEOUT_MS = 3000;

/**
 * Перечитує гаманці для одного приватного з'єднання. HTTP-резерв і release сапера публікують
 * `wallet.updated` best effort: без звірки втрачена подія лишила б баланс застарілим до
 * перепідключення. Старіша відповідь не перезапише новішу подію, бо стан зливається за `version`.
 */
export function startWalletRefresh<T>(
  read: (signal: AbortSignal) => Promise<T>,
  onWallets: (wallets: T) => void,
  clock: Clock = realClock,
) {
  let stopped = false;
  let started = false;
  let timer: unknown;
  let planned: 'soon' | 'later' | undefined;
  let request: AbortController | undefined;
  let deadline: unknown;
  let again = false;

  function plan(soon: boolean) {
    // Період іде лише після першого snapshot: до нього гаманці читає саме snapshot.
    if (stopped || (!soon && !started)) return;
    // Читання, що вже йде, могло початися до коміту, про який повідомила подія.
    if (request) {
      again ||= soon;
      return;
    }
    // Нова подія не відкладає вже заплановане швидке читання, інакше потік подій його б зголодив.
    if (planned === 'soon' || (planned === 'later' && !soon)) return;
    clock.clearTimeout(timer);
    planned = soon ? 'soon' : 'later';
    timer = clock.setTimeout(() => void run(), soon ? WALLET_EVENT_DELAY_MS : WALLET_REFRESH_MS);
  }

  async function run() {
    planned = undefined;
    timer = undefined;
    const current = new AbortController();
    request = current;
    // Дедлайн звільняє чергу сам: читання, що не завершилось після abort, не зупинить звірку.
    // Кожне читання знімає лише свій таймер: запізніле не зачепить дедлайн наступного.
    const timeout = clock.setTimeout(() => {
      current.abort();
      finish(current);
    }, WALLET_TIMEOUT_MS);
    deadline = timeout;
    try {
      const wallets = await read(current.signal);
      if (!current.signal.aborted) onWallets(wallets);
    } catch {
      // Тимчасовий збій не показуємо: наступна звірка повторить читання.
    } finally {
      clock.clearTimeout(timeout);
      finish(current);
    }
  }

  function finish(current: AbortController) {
    if (request !== current) return;
    request = undefined;
    const soon = again;
    again = false;
    plan(soon);
  }

  return {
    /** Запускає періодичну звірку; кожне завершене читання планує наступне. */
    start() {
      started = true;
      plan(false);
    },
    /** Подія заявки приходить після коміту резерву, тож читання після неї бачить новий баланс. */
    changed: () => plan(true),
    stop() {
      stopped = true;
      clock.clearTimeout(timer);
      clock.clearTimeout(deadline);
      planned = undefined;
      request?.abort();
      request = undefined;
    },
  };
}
