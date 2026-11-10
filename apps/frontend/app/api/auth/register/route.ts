import { NextRequest } from 'next/server';
import { authAction } from '../../../../lib/session';

export function POST(request: NextRequest) {
  return authAction(request, 'register');
}
