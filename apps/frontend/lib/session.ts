import { NextRequest, NextResponse } from 'next/server';
import {
  backendHeaders,
  backendResponse,
  backendUrl,
  forbiddenOrigin,
  sameOrigin,
  unavailable,
} from './api';

export const ACCESS_COOKIE = 'exchange_access';
const REFRESH_COOKIE = 'exchange_refresh';

type Claims = { exp: number; sub?: string; sid?: string; roles?: string[] };
type Tokens = { accessToken: string; refreshToken?: string };

// Термін дії підказує, коли оновити токен. Підпис і права завжди перевіряє API.
export function claims(token?: string): Claims | undefined {
  try {
    const part = token?.split('.')[1];
    if (!part) return;
    const base64 = part.replace(/-/g, '+').replace(/_/g, '/');
    const value = JSON.parse(atob(base64)) as Claims;
    if (typeof value?.exp === 'number') return value;
  } catch {
    return;
  }
}

function setCookie(response: NextResponse, name: string, token: string, maxAge?: number) {
  response.cookies.set(name, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === 'true',
    path: '/',
    maxAge,
  });
}

export function setTokens(response: NextResponse, tokens: Tokens) {
  const now = Math.floor(Date.now() / 1000);
  const age = (token: string) => {
    const expiry = claims(token)?.exp;
    return expiry === undefined ? undefined : Math.max(0, expiry - now);
  };
  setCookie(response, ACCESS_COOKIE, tokens.accessToken, age(tokens.accessToken));
  // D18: відповідь у grace не має замінювати вже ротований refresh.
  if (tokens.refreshToken) {
    setCookie(response, REFRESH_COOKIE, tokens.refreshToken, age(tokens.refreshToken));
  }
}

export function clearTokens(response: NextResponse) {
  setCookie(response, ACCESS_COOKIE, '', 0);
  setCookie(response, REFRESH_COOKIE, '', 0);
}

async function authFetch(request: Request, action: string, body: string) {
  const headers = backendHeaders(request);
  headers.set('content-type', 'application/json');
  return fetch(backendUrl('engine') + '/auth/' + action, {
    method: 'POST',
    body,
    headers,
    cache: 'no-store',
    redirect: 'manual',
  });
}

export async function authAction(request: NextRequest, action: 'login' | 'register' | 'logout') {
  if (!sameOrigin(request)) return forbiddenOrigin();
  try {
    if (action === 'logout') {
      const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
      if (refreshToken) {
        const result = await authFetch(request, 'logout', JSON.stringify({ refreshToken }));
        if (!result.ok && result.status !== 401) return backendResponse(result);
      }
      const response = new NextResponse(null, {
        status: 204,
        headers: { 'cache-control': 'no-store' },
      });
      clearTokens(response);
      return response;
    }

    const upstream = await authFetch(request, action, await request.text());
    if (!upstream.ok) return backendResponse(upstream);
    const tokens: Tokens = await upstream.json();
    if (!tokens.accessToken || !tokens.refreshToken) return unavailable();
    const response = new NextResponse(null, {
      status: 204,
      headers: { 'cache-control': 'no-store' },
    });
    setTokens(response, tokens);
    return response;
  } catch {
    return unavailable();
  }
}

export async function refreshSession(request: NextRequest) {
  const refreshToken = request.cookies.get(REFRESH_COOKIE)?.value;
  if (!refreshToken) return { expired: false };
  const upstream = await authFetch(request, 'refresh', JSON.stringify({ refreshToken }));
  if (upstream.status === 401) return { expired: true };
  if (!upstream.ok) return { expired: false, failure: backendResponse(upstream) };
  const tokens: Tokens = await upstream.json();
  if (!tokens.accessToken) return { expired: false, failure: unavailable() };
  return { expired: false, tokens };
}
