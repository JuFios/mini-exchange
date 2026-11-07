import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { ChaosHooks } from '../../src/chaos/chaos-hooks';
import { ChaosController } from '../../src/chaos/chaos.controller';
import { JwtAuthGuard } from '../../src/auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../src/auth/guards/roles.guard';
import { configureApp } from '../../src/configure-app';

it.each(['after_writes_before_commit', 'after_commit_before_memory'])(
  'arms %s through the HTTP DTO and triggers on the eligible command',
  async (point) => {
    const module = await Test.createTestingModule({
      controllers: [ChaosController],
      providers: [
        ChaosHooks,
        RolesGuard,
        { provide: ConfigService, useValue: { getOrThrow: () => true } },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({
        canActivate: (context: { switchToHttp(): { getRequest(): { user?: unknown } } }) => {
          context.switchToHttp().getRequest().user = { roles: ['admin'] };
          return true;
        },
      })
      .compile();
    const app: INestApplication = module.createNestApplication({ logger: false });
    const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
    try {
      configureApp(app);
      await app.listen(0, '127.0.0.1');
      const response = await fetch(`${await app.getUrl()}/admin/chaos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ point, fromSeq: 5, requireTrades: true }),
        signal: AbortSignal.timeout(3000),
      });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ armed: point });
      const hooks = app.get(ChaosHooks);
      expect(hooks['armed']).toEqual({ point, fromSeq: 5, requireTrades: true });
      await hooks.reach(point, '4', 1);
      await hooks.reach(point, '5', 0);
      expect(kill).not.toHaveBeenCalled();
      await hooks.reach(point, '5', 1);
      expect(kill).toHaveBeenCalledWith(process.pid, 'SIGKILL');
      await hooks.reach(point, '6', 1);
      expect(kill).toHaveBeenCalledTimes(1);
    } finally {
      kill.mockRestore();
      await app.close();
    }
  },
);
