import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { RateLimits } from '../../security/rate-limits';
import { JwtPayload, JwtStrategy } from '../strategies/jwt.strategy';

export const LimitOrderWrites = Reflector.createDecorator<boolean>();

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly strategy: JwtStrategy,
    private readonly reflector: Reflector,
    private readonly limits: RateLimits,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Passport реєструє іменовану стратегію глобально. Запит має перевіряти сесію через
    // репозиторій свого застосунку, навіть якщо інша репліка в цьому процесі закривається.
    const request = context.switchToHttp().getRequest<Request>();
    // До перевірки сесії в PG, щоб запити понад квоту не займали з’єднання з пулу.
    const beforeSession = this.reflector.get(LimitOrderWrites, context.getHandler())
      ? ({ sub, sid }: JwtPayload) => this.limits.orderWrite(sub, sid)
      : undefined;
    request.user = await this.strategy.authenticate(request, beforeSession);
    return true;
  }
}
