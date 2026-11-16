export type Service = 'engine' | 'settlement';

export function backendUrl(service: Service) {
  return service === 'engine'
    ? (process.env.MATCHING_ENGINE_URL ?? 'http://localhost:3001')
    : (process.env.SETTLEMENT_URL ?? 'http://localhost:3002');
}

function parsePublicOrigin(value: string, key: 'PUBLIC_ORIGIN' | 'PUBLIC_ORIGINS'): URL {
  const origin = value.replace(/^[ \t]+|[ \t]+$/g, '').replace(/\/$/, '');
  const authority = /^https?:\/\/([a-z0-9][a-z0-9.-]*|\[[0-9a-f:]+\])(?::([0-9]+))?$/i.exec(origin);
  if (authority) {
    const url = URL.canParse(origin) ? new URL(origin) : undefined;
    if (
      url &&
      (authority[1].startsWith('[') || url.hostname === authority[1].toLowerCase()) &&
      url.port !== '0'
    )
      return url;
  }
  throw new Error(key + ' must contain HTTP origins without paths or credentials');
}

export function allowedOrigins(): URL[] {
  const configured = process.env.PUBLIC_ORIGIN;
  if (configured) {
    const url = parsePublicOrigin(configured, 'PUBLIC_ORIGIN');
    if (process.env.COOKIE_SECURE === 'true' && url.protocol !== 'https:')
      throw new Error('Remote PUBLIC_ORIGIN must use HTTPS');
    return [url];
  }
  if (process.env.COOKIE_SECURE === 'true') throw new Error('PUBLIC_ORIGIN is required');
  return (process.env.PUBLIC_ORIGINS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((origin) => parsePublicOrigin(origin, 'PUBLIC_ORIGINS'));
}

function selectOrigin(request: Request) {
  const url = new URL(request.url);
  const host = (request.headers.get('host') ?? url.host).toLowerCase();
  const origins = allowedOrigins();
  const matched = origins.find(
    (origin) =>
      origin.host === host && (process.env.PUBLIC_ORIGIN || origin.protocol === url.protocol),
  );
  return { matched, fallback: origins[0] };
}

export function requestOrigin(request: Request) {
  const { matched, fallback } = selectOrigin(request);
  return (matched ?? fallback).origin;
}

export function sameOrigin(request: Request) {
  return selectOrigin(request).matched?.origin === request.headers.get('origin');
}

export function frontendProxyToken() {
  const token = process.env.FRONTEND_PROXY_TOKEN;
  if (
    process.env.COOKIE_SECURE === 'true' &&
    (!token || !/^[A-Za-z0-9_-]{32,128}$/.test(token) || token.includes('local-only'))
  ) {
    throw new Error('FRONTEND_PROXY_TOKEN must be a non-demo base64url token in remote mode');
  }
  return token ?? 'demo-frontend-proxy-local-only-000001';
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
