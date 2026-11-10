import { NextRequest } from 'next/server';
import { proxy } from '../../../../lib/proxy';

export function GET(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, 'settlement', params.path);
}

export const POST = GET;
