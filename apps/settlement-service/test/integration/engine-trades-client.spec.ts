import { createServer, Server } from 'node:http';
import { BadGatewayException } from '@nestjs/common';
import { EngineTradesClient } from '../../src/reconciliation/engine-trades.client';

let server: Server;
let requests: URL[] = [];
let respond: (url: URL) => { status: number; body: unknown } = () => ({ status: 200, body: {} });
const token = 'x'.repeat(32);
const client = () =>
  new EngineTradesClient({
    getOrThrow: (key: string) =>
      ({
        ENGINE_INTERNAL_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        INTERNAL_API_TOKEN: token,
      })[key],
  } as never);
const period = { from: '2026-01-01T00:00:00.000Z', to: '2026-01-02T00:00:00.000Z' };
const collect = async () => {
  const trades: unknown[] = [];
  for await (const trade of client().trades({ ...period, instrument: 'ABC' })) trades.push(trade);
  return trades;
};

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://engine');
    requests.push(url);
    const { status, body } =
      request.headers['x-internal-token'] === token ? respond(url) : { status: 401, body: {} };
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  requests = [];
});

it('follows the cursor until the engine reports no next page and sends the token', async () => {
  respond = (url) =>
    url.searchParams.get('after')
      ? { status: 200, body: { trades: [{ tradeId: 'b' }], next: null } }
      : { status: 200, body: { trades: [{ tradeId: 'a' }], next: '2026-01-01T00:00:00.000Z,a' } };
  expect(await collect()).toEqual([{ tradeId: 'a' }, { tradeId: 'b' }]);
  expect(requests.map((url) => url.searchParams.get('after'))).toEqual([
    null,
    '2026-01-01T00:00:00.000Z,a',
  ]);
  expect(requests[0].searchParams.get('instrument')).toBe('ABC');
});

it('reports an unavailable engine as a bad gateway instead of an empty period', async () => {
  respond = () => ({ status: 500, body: {} });
  await expect(collect()).rejects.toBeInstanceOf(BadGatewayException);
});
