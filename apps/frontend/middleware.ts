import { NextRequest, NextResponse } from 'next/server';
import { requestOrigin, sameOrigin, unavailable } from './lib/api';
import { publicWsUrl } from './lib/public-ws';
import { ACCESS_COOKIE, claims, clearTokens, refreshSession, setTokens } from './lib/session';
import { DEFER_REFRESH_HEADER } from './lib/session-binding';

// Токен оновлюється із запасом: до backend запит доходить пізніше, ніж його бачить middleware.
const EXPIRY_MARGIN_MS = 30_000;

function securityHeaders(response: Response, csp: string) {
  response.headers.set('content-security-policy', csp);
  if (process.env.COOKIE_SECURE === 'true')
    response.headers.set('strict-transport-security', 'max-age=31536000');
  return response;
}

export async function middleware(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64');
  const ws = publicWsUrl();
  if (ws.protocol === 'http:') ws.protocol = 'ws:';
  if (ws.protocol === 'https:') ws.protocol = 'wss:';
  const development = process.env.NODE_ENV === 'development';
  const csp = `default-src 'self'; script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self' ${ws.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`;
  const path = request.nextUrl.pathname;
  const protectedPage = path.startsWith('/exchange/') || path === '/admin/status';
  const refresh =
    protectedPage ||
    /^\/api\/(?:orders|engine|settlement|auth\/(?:ws-token|refresh))(?:\/|$)/.test(path);
  // Refresh ротує токен, а нові cookie приходять із відповіддю. Обірваний клієнтом запит їх
  // втратив би, і наступне оновлення відкликало б сесію. Такий запит оновлення не запускає:
  // після 401 клієнт оновлює сесію окремим запитом `/api/auth/refresh`.
  const deferred = request.headers.has(DEFER_REFRESH_HEADER);
  let token = claims(request.cookies.get(ACCESS_COOKIE)?.value);
  let update: Awaited<ReturnType<typeof refreshSession>> | undefined;

  const now = Date.now();
  const expired = !token?.sid || token.exp * 1000 <= now;
  const nearExpiry = !token?.sid || token.exp * 1000 - EXPIRY_MARGIN_MS <= now;
  const navigation = request.method === 'GET' || request.method === 'HEAD';
  const site = request.headers.get('sec-fetch-site');
  const trustedNavigation = site === null || site === 'none' || site === 'same-origin';

  // Сторінка сама до backend не ходить, тож запас перед `exp` їй не потрібен. Навігацію браузер
  // обриває частіше за fetch, а обрив після ротації лишає старий refresh у cookie, і наступне
  // оновлення після grace відкликає сесію. Тому сторінка оновлює лише вже прострочений токен.
  if (refresh && (protectedPage ? expired : nearExpiry) && !deferred) {
    // Для мутацій Origin перевіряється також до можливого refresh.
    if (navigation || sameOrigin(request)) {
      try {
        // Перехід з іншого сайту може обірвати чужа сторінка відразу після відповіді. Обірвана
        // ротація лишила б старий refresh, і наступне оновлення після grace відкликало б сесію.
        // Тому такий перехід отримує лише новий access JWT, а refresh-cookie не змінюється.
        update = await refreshSession(request, !navigation || trustedNavigation);
        // Токен із запасу ще чинний: збій refresh не має його відбирати. Без чинного токена
        // тимчасовий збій (503, 429) віддається як є і на сторінці: перехід на /login
        // змусив би увійти знову, а новий вхід відкликає сесію в інших вкладках і пристроях.
        if (update.failure && expired) return securityHeaders(update.failure, csp);
        if (expired || update.tokens) {
          token = undefined;
          if (update.tokens) {
            request.cookies.set(ACCESS_COOKIE, update.tokens.accessToken);
            token = claims(update.tokens.accessToken);
          }
        }
      } catch {
        if (expired) return securityHeaders(unavailable(), csp);
      }
    }
  }

  let response: NextResponse;
  if (protectedPage && !token) {
    response = NextResponse.redirect(new URL('/login', requestOrigin(request)));
  } else if (path === '/admin/status' && !token?.roles?.includes('admin')) {
    response = NextResponse.redirect(new URL('/exchange/ABC', requestOrigin(request)));
  } else {
    const headers = new Headers(request.headers);
    headers.set('x-nonce', nonce);
    headers.set('content-security-policy', csp);
    response = NextResponse.next({ request: { headers } });
  }
  if (update?.tokens) setTokens(response, update.tokens);
  if (update?.expired) clearTokens(response);

  return securityHeaders(response, csp);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
