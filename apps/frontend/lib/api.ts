export type Service = 'engine' | 'settlement';

export function backendUrl(service: Service) {
  return service === 'engine'
    ? (process.env.MATCHING_ENGINE_URL ?? 'http://localhost:3001')
    : (process.env.SETTLEMENT_URL ?? 'http://localhost:3002');
}

export function sameOrigin(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get('host') ?? url.host;
  // У віддаленому режимі TLS завершується перед контейнером.
  const protocol = process.env.COOKIE_SECURE === 'true' ? 'https:' : url.protocol;
  return request.headers.get('origin') === protocol + '//' + host;
}

export function backendHeaders(request: Request) {
  const headers = new Headers();
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
