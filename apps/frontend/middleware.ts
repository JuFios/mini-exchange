import { NextRequest, NextResponse } from 'next/server';
import { requestOrigin, sameOrigin, unavailable } from './lib/api';
import { publicWsUrl } from './lib/public-ws';
import { ACCESS_COOKIE, claims, clearTokens, refreshSession, setTokens } from './lib/session';
import { DEFER_REFRESH_HEADER } from './lib/session-binding';

// Токен оновлюється із запасом: до backend запит доходить пізніше, ніж його бачить middleware.
const EXPIRY_MARGIN_MS = 30_000;

export async function middleware(request: NextRequest) {
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

  if (refresh && nearExpiry && !deferred) {
    // Для мутацій Origin перевіряється також до можливого refresh.
    if (request.method === 'GET' || request.method === 'HEAD' || sameOrigin(request)) {
      try {
        update = await refreshSession(request);
        // Токен із запасу ще чинний: збій refresh не має його відбирати.
        if (update.failure && !protectedPage && expired) return update.failure;
        if (expired || update.tokens) {
          token = undefined;
          if (update.tokens) {
            request.cookies.set(ACCESS_COOKIE, update.tokens.accessToken);
            token = claims(update.tokens.accessToken);
          }
        }
      } catch {
        if (expired) {
          if (!protectedPage) return unavailable();
          token = undefined;
        }
      }
    }
  }

  let response: NextResponse;
  if (protectedPage && !token) {
    response = NextResponse.redirect(new URL('/login', requestOrigin(request)));
  } else if (path === '/admin/status' && !token?.roles?.includes('admin')) {
    response = NextResponse.redirect(new URL('/exchange/ABC', requestOrigin(request)));
  } else {
    response = update?.tokens
      ? NextResponse.next({ request: { headers: new Headers(request.headers) } })
      : NextResponse.next();
  }
  if (update?.tokens) setTokens(response, update.tokens);
  if (update?.expired) clearTokens(response);

  // Заголовки next.config вшиваються під час збірки, а WS origin задає runtime.
  const ws = publicWsUrl();
  if (ws.protocol === 'http:') ws.protocol = 'ws:';
  if (ws.protocol === 'https:') ws.protocol = 'wss:';
  const development = process.env.NODE_ENV === 'development';
  response.headers.set(
    'content-security-policy',
    `default-src 'self'; script-src 'self' 'unsafe-inline'${development ? " 'unsafe-eval'" : ''}; style-src 'self' 'unsafe-inline'; connect-src 'self' ${ws.origin}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`,
  );
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
