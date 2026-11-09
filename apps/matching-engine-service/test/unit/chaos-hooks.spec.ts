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

it('stalls once at stall_before_commit without killing the process', async () => {
  const values: Record<string, unknown> = {
    CHAOS_ENABLED: true,
    CHAOS_STALL_BEFORE_COMMIT_MS: 30,
  };
  const hooks = new ChaosHooks({ getOrThrow: (key: string) => values[key] } as ConfigService);
  const kill = jest.spyOn(process, 'kill').mockReturnValue(true);
  try {
    hooks.arm({ point: 'stall_before_commit', fromSeq: 2 });
    const early = performance.now();
    await hooks.reach('stall_before_commit', '1', 0);
    expect(performance.now() - early).toBeLessThan(25);
    const started = performance.now();
    await hooks.reach('stall_before_commit', '2', 0);
    expect(performance.now() - started).toBeGreaterThanOrEqual(25);
    const again = performance.now();
    await hooks.reach('stall_before_commit', '3', 0);
    expect(performance.now() - again).toBeLessThan(25);
    expect(kill).not.toHaveBeenCalled();
  } finally {
    kill.mockRestore();
  }
});

it('freezes and unfreezes the stream reader without touching the armed one-shot point', () => {
  const values: Record<string, unknown> = { CHAOS_ENABLED: true };
  const hooks = new ChaosHooks({ getOrThrow: (key: string) => values[key] } as ConfigService);
  expect(hooks.readerFrozen).toBe(false);
  hooks.arm({ point: 'after_writes_before_commit', fromSeq: 3 });
  expect(hooks.arm({ point: 'freeze_stream_reader' })).toEqual({ armed: 'freeze_stream_reader' });
  expect(hooks.readerFrozen).toBe(true);
  expect(hooks['armed']).toEqual({ point: 'after_writes_before_commit', fromSeq: 3 });
  hooks.arm({ point: 'unfreeze_stream_reader' });
  expect(hooks.readerFrozen).toBe(false);
});

it('refuses to freeze the stream reader when chaos is disabled', () => {
  const hooks = new ChaosHooks({ getOrThrow: () => false } as unknown as ConfigService);
  expect(() => hooks.arm({ point: 'freeze_stream_reader' })).toThrow();
  expect(hooks.readerFrozen).toBe(false);
});
