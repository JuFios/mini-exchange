import { createServer, Server } from 'node:http';
import { BadGatewayException } from '@nestjs/common';
import { EngineOrdersClient } from '../../src/reconciliation/engine-orders.client';

let server: Server;
let requests: { method?: string; path?: string; token?: string; body: unknown }[] = [];
let respond: () => { status: number; body: unknown } = () => ({
  status: 200,
  body: { orders: [] },
});
const token = 'x'.repeat(32);
const client = (secret = token) =>
  new EngineOrdersClient({
    getOrThrow: (key: string) =>
      ({
        ENGINE_INTERNAL_URL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
        INTERNAL_API_TOKEN: secret,
      })[key],
  } as never);

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      requests.push({
        method: request.method,
        path: request.url,
        token: request.headers['x-internal-token'] as string | undefined,
        body: JSON.parse(Buffer.concat(chunks).toString() || 'null'),
      });
      const { status, body } =
        request.headers['x-internal-token'] === token ? respond() : { status: 401, body: {} };
      response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
});
afterAll(() => new Promise((resolve) => server.close(resolve)));
beforeEach(() => {
  requests = [];
  respond = () => ({ status: 200, body: { orders: [] } });
});

it('posts the order IDs with the internal token and returns the terminal orders', async () => {
  const order = { orderId: 'a', instrument: 'ABC', status: 'filled', closedAt: 'now' };
  respond = () => ({ status: 200, body: { orders: [order] } });
  expect(await client().terminal(['a', 'b'])).toEqual([order]);
  expect(requests).toEqual([
    { method: 'POST', path: '/internal/orders/terminal', token, body: { orderIds: ['a', 'b'] } },
  ]);
});

it('does not call the engine for an empty list', async () => {
  expect(await client().terminal([])).toEqual([]);
  expect(requests).toEqual([]);
});

it('reports an unavailable or unauthorised engine as a bad gateway instead of no stuck orders', async () => {
  respond = () => ({ status: 500, body: {} });
  await expect(client().terminal(['a'])).rejects.toBeInstanceOf(BadGatewayException);
  await expect(client('y'.repeat(32)).terminal(['a'])).rejects.toBeInstanceOf(BadGatewayException);
});
