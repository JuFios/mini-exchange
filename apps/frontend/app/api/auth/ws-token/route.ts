import { NextRequest } from 'next/server';
import {
  backendHeaders,
  backendResponse,
  backendUrl,
  forbiddenOrigin,
  sameOrigin,
  unavailable,
} from '../../../../lib/api';
import { ACCESS_COOKIE } from '../../../../lib/session';

export async function POST(request: NextRequest) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  const headers = { 'cache-control': 'no-store' };
  if (!token) return Response.json({ message: 'Потрібен вхід' }, { status: 401, headers });
  try {
    const upstreamHeaders = backendHeaders(request);
    upstreamHeaders.set('authorization', 'Bearer ' + token);
    const upstream = await fetch(backendUrl('engine') + '/auth/ws-token', {
      method: 'POST',
      headers: upstreamHeaders,
      cache: 'no-store',
      redirect: 'manual',
      signal: AbortSignal.timeout(3000),
    });
    if (!upstream.ok) return backendResponse(upstream);
    const body = await upstream.json();
    if (typeof body.token !== 'string' || typeof body.userId !== 'string') return unavailable();
    return Response.json({ token: body.token, userId: body.userId }, { headers });
  } catch {
    return unavailable();
  }
}
