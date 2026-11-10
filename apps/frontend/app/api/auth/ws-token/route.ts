import { NextRequest } from 'next/server';
import { forbiddenOrigin, sameOrigin } from '../../../../lib/api';
import { ACCESS_COOKIE, claims } from '../../../../lib/session';

export function POST(request: NextRequest) {
  if (!sameOrigin(request)) return forbiddenOrigin();
  const token = request.cookies.get(ACCESS_COOKIE)?.value;
  const headers = { 'cache-control': 'no-store' };
  if (!token) return Response.json({ message: 'Потрібен вхід' }, { status: 401, headers });
  return Response.json({ token, userId: claims(token)?.sub }, { headers });
}
