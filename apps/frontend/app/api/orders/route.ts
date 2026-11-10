import { NextRequest } from 'next/server';
import { proxy } from '../../../lib/proxy';

export function POST(request: NextRequest) {
  return proxy(request, 'engine', ['orders']);
}
