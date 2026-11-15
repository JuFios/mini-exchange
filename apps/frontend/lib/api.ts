export type Service = 'engine' | 'settlement';

export function backendUrl(service: Service) {
  return service === 'engine'
    ? (process.env.MATCHING_ENGINE_URL ?? 'http://localhost:3001')
    : (process.env.SETTLEMENT_URL ?? 'http://localhost:3002');
}

export function requestOrigin(request: Request) {
  const configured = process.env.PUBLIC_ORIGIN;
  if (configured) {
    const url = new URL(configured);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.origin !== configured ||
      (process.env.COOKIE_SECURE === 'true' && url.protocol !== 'https:')
    ) {
      throw new Error('PUBLIC_ORIGIN must be an HTTP origin without a path');
    }
    return configured;
  }
  if (process.env.COOKIE_SECURE === 'true') throw new Error('PUBLIC_ORIGIN is required');
  const host = (request.headers.get('host') ?? new URL(request.url).host).toLowerCase();
  const origins = (process.env.PUBLIC_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => origin.trim());
  for (const origin of origins) {
    const url = new URL(origin);
    if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
      throw new Error('PUBLIC_ORIGINS must contain HTTP origins');
    if (url.host === host) return origin;
  }
  return origins[0];
}

export function sameOrigin(request: Request) {
  const origin = requestOrigin(request);
  const host = request.headers.get('host') ?? new URL(request.url).host;
  return request.headers.get('origin') === origin && host.toLowerCase() === new URL(origin).host;
}

export function frontendProxyToken() {
  return process.env.FRONTEND_PROXY_TOKEN ?? 'demo-frontend-proxy-local-only-000001';
}

export function backendHeaders(request: Request, service: Service = 'engine') {
  const headers = new Headers();
  if (
    service === 'engine' ||
    new URL(backendUrl(service)).origin === new URL(backendUrl('engine')).origin
  )
    headers.set('x-frontend-proxy', frontendProxyToken());
  for (const name of ['content-type', 'idempotency-key']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Зовнішній listener nginx перезаписує заголовок адресою з'єднання.
  const address = request.headers.get('x-forwarded-for')?.split(',').at(-1)?.trim();
  if (address) headers.set('x-forwarded-for', address);
  return headers;
}

export function backendResponse(upstream: Response) {
  const type = upstream.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (upstream.status >= 500 && type !== 'application/json' && !type?.endsWith('+json')) {
    void upstream.body?.cancel().catch(() => undefined);
    return unavailable();
  }
  const headers = new Headers({ 'cache-control': 'no-store' });
  for (const name of ['content-type', 'retry-after']) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}

export function unavailable() {
  return Response.json({ message: 'Сервіс тимчасово недоступний' }, { status: 503 });
}

export function forbiddenOrigin() {
  return Response.json({ message: 'Запит з іншого джерела заборонено' }, { status: 403 });
}
