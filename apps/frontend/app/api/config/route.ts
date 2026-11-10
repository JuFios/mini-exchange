import { publicWsUrl } from '../../../lib/public-ws';

export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { wsUrl: publicWsUrl().origin },
    { headers: { 'cache-control': 'no-store' } },
  );
}
