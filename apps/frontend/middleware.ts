import { NextRequest, NextResponse } from 'next/server';
import { sameOrigin, unavailable } from './lib/api';
import { publicWsUrl } from './lib/public-ws';
import { ACCESS_COOKIE, claims, clearTokens, refreshSession, setTokens } from './lib/session';

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const protectedPage = path.startsWith('/exchange/') || path === '/admin/status';
  const refresh =
    protectedPage || /^\/api\/(?:orders|engine|settlement|auth\/ws-token)(?:\/|$)/.test(path);
  let token = claims(request.cookies.get(ACCESS_COOKIE)?.value);
  let update: Awaited<ReturnType<typeof refreshSession>> | undefined;

  if (refresh && (!token || token.exp * 1000 <= Date.now())) {
    // Для мутацій Origin перевіряється також до можливого refresh.
    if (request.method === 'GET' || request.method === 'HEAD' || sameOrigin(request)) {
      try {
        update = await refreshSession(request);
        if (update.failure && !protectedPage) return update.failure;
        token = undefined;
        if (update.tokens) {
          request.cookies.set(ACCESS_COOKIE, update.tokens.accessToken);
          token = claims(update.tokens.accessToken);
        }
      } catch {
        if (!protectedPage) return unavailable();
        token = undefined;
      }
    }
  }

  let response: NextResponse;
  if (protectedPage && !token) {
    response = NextResponse.redirect(new URL('/login', request.url));
  } else if (path === '/admin/status' && !token?.roles?.includes('admin')) {
    response = NextResponse.redirect(new URL('/exchange/ABC', request.url));
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
