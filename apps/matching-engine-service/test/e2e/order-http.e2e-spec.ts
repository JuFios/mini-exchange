import { JwtService } from '@nestjs/jwt';
import { engineApp } from './engine-app';

const { register, request, submit } = engineApp();

it('requires a JWT for the private order list', async () => {
  expect((await request('/orders')).status).toBe(401);
});

it('rejects a correctly signed token without a valid owner identifier', async () => {
  const token = new JwtService().sign({ email: 'no-owner@example.test' }, {
    secret: process.env.JWT_ACCESS_SECRET,
  });
  expect((await request('/orders', 'GET', token)).status).toBe(401);
});

it.each(['__proto__', 'constructor', 'toString', 'ownerId'])('rejects the extra request field %s', async (field) => {
  const owner = await register();
  const response = await submit(owner, { [field]: {} });
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ message: [`Зайве поле ${field}`] });
});
