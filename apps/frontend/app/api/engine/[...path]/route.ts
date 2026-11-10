import { NextRequest } from 'next/server';
import { proxy } from '../../../../lib/proxy';

function handle(request: NextRequest, { params }: { params: { path: string[] } }) {
  return proxy(request, 'engine', params.path);
}

export { handle as GET, handle as POST, handle as DELETE };
