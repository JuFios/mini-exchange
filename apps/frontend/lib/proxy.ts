import { NextRequest } from 'next/server';
import {
  backendHeaders,
  backendResponse,
  backendUrl,
  forbiddenOrigin,
  sameOrigin,
  Service,
  unavailable,
} from './api';
import { ACCESS_COOKIE, claims } from './session';
import { SESSION_HEADER } from './session-binding';

const routes: Record<Service, Partial<Record<string, RegExp>>> = {
  engine: {
    GET: /^(?:instruments(?:\/[\w-]+\/(?:book|trades))?|orders(?:\/[\w-]+)?|admin\/instruments)$/,
    POST: /^orders$/,
    DELETE: /^orders\/[\w-]+$/,
  },
  settlement: { GET: /^(?:wallets|admin\/(?:queue|reconciliation))$/ },
};

export async function proxy(request: NextRequest, service: Service, path: string[]) {
  if (path.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment) || /\s/.test(segment))) {
    return Response.json({ message: 'Некоректний шлях' }, { status: 400 });
  }
  const route = path.join('/');
  if (!routes[service][request.method]?.test(route) || route === 'orders/book') {
    return Response.json({ message: 'Маршрут не знайдено' }, { status: 404 });
  }
  if (request.method !== 'GET' && !sameOrigin(request)) return forbiddenOrigin();

  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  // Cookie спільні для вкладок, а вкладка пам'ятає користувача зі свого підключення.
  // Мутація без збігу ніколи не йде від імені іншого рахунку, читання — лише якщо збіг відомий.
  const expected = request.headers.get(SESSION_HEADER);
  const current = claims(token)?.sub;
  if (current && expected !== current && (request.method !== 'GET' || expected)) {
    return Response.json(
      { message: 'Сесію змінено в іншій вкладці. Оновлюємо сторінку.', code: 'session_changed' },
      { status: 409, headers: { 'cache-control': 'no-store' } },
    );
  }

  const headers = backendHeaders(request);
  if (token) headers.set('authorization', 'Bearer ' + token);
  try {
    const result = await fetch(backendUrl(service) + '/' + route + request.nextUrl.search, {
      method: request.method,
      headers,
      body: request.method === 'POST' ? await request.text() : undefined,
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    });
    return backendResponse(result);
  } catch {
    return unavailable();
  }
}
