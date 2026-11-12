import { NextRequest } from 'next/server';
import { forbiddenOrigin, sameOrigin } from '../../../../lib/api';
import { ACCESS_COOKIE, claims } from '../../../../lib/session';

// Сесію оновлює middleware. Маршрут лише повідомляє, чи є після цього чинний access-токен.
export function POST(request: NextRequest) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const expiry = claims(request.cookies.get(ACCESS_COOKIE)?.value)?.exp;
  const active = expiry !== undefined && expiry * 1000 > Date.now();
  return new Response(null, {
    status: active ? 204 : 401,
    headers: { 'cache-control': 'no-store' },
  });
}
