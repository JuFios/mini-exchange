import { createServer, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Reservation } from '../../../src/intake/reservation.client';

export class FakeSettlement {
  readonly reservations = new Map<string, Reservation>();
  readonly released = new Set<string>();
  readonly reserveIds: string[] = [];
  readonly releaseIds: string[] = [];
  holdReserve = false;
  holdRelease = false;
  failReleases = 0;
  balance?: bigint;

  private readonly server = createServer((req, res) => {
    const run = async () => {
      if (req.method !== 'POST' || req.headers['x-internal-token'] !== this.token) {
        this.respond(res, 401);
        return;
      }
      if (req.url === '/internal/reservations') {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const reservation: Reservation = JSON.parse(Buffer.concat(chunks).toString());
        const { reservationId } = reservation;
        this.reserveIds.push(reservationId);
        if (this.released.has(reservationId)) {
          this.respond(res, 409, { code: 'ALREADY_RELEASED' });
        } else if (this.balance !== undefined && BigInt(reservation.amount) > this.balance) {
          this.respond(res, 422, { code: 'INSUFFICIENT_FUNDS' });
        } else {
          this.reservations.set(reservationId, reservation);
          if (!this.holdReserve) this.respond(res, 201, { status: 'accepted' });
        }
        return;
      }
      const match = /^\/internal\/reservations\/([^/]+)\/release$/.exec(req.url ?? '');
      if (!match) {
        this.respond(res, 404);
        return;
      }
      const [, id] = match;
      this.releaseIds.push(id);
      if (this.releaseIds.length <= this.failReleases) {
        this.respond(res, 503);
      } else if (!this.holdRelease) {
        this.released.add(id);
        this.respond(res, 200, { status: 'released' });
      }
    };
    void run().catch(() => this.respond(res, 500));
  });

  constructor(private readonly token: string) {}

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => (error ? reject(error) : resolve()));
      this.server.closeAllConnections();
    });
  }

  private respond(res: ServerResponse, status: number, body = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }
}
