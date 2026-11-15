import { headers } from 'next/headers';

// Адреса з ingress для запитів серверних компонентів до engine, як у проксі API (`backendHeaders`).
export function clientAddress() {
  return headers().get('x-forwarded-for')?.split(',').at(-1)?.trim() || undefined;
}
