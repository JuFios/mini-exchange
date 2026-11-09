import { randomUUID } from 'node:crypto';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { migrate } from '../../src/database/migrate';
import { ledgerApp } from '../ledger-app';

const ledger = ledgerApp({ DEMO_INITIAL_BALANCES: 'USD:6000000000000000000000000000,ABC:0,XYZ:0' });

it('creates wallets for multiple owners when cumulative genesis exceeds one posting', async () => {
  const jwt = new JwtService({ secret: ledger.jwtSecret });
  for (let user = 0; user < 3; user++) {
    const token = jwt.sign({ sub: randomUUID(), typ: 'access' }, { expiresIn: '15m' });
    const response = await request(ledger.app().getHttpServer())
      .get('/wallets')
      .auth(token, { type: 'bearer' })
      .expect(200);
    expect(response.body).toContainEqual({
      asset: 'USD',
      available: '6000000000000000000000000000.0000000000',
      reserved: '0.0000000000',
    });
  }
  expect(
    await ledger
      .source()
      .query('SELECT asset FROM accounts GROUP BY asset HAVING SUM(balance) <> 0'),
  ).toEqual([]);
  await expect(migrate(ledger.source(), 'revert')).rejects.toMatchObject({ code: '22003' });
  expect(
    await ledger
      .source()
      .query(
        "SELECT numeric_precision FROM information_schema.columns WHERE table_name='accounts' AND column_name='balance'",
      ),
  ).toEqual([{ numeric_precision: 57 }]);
});
