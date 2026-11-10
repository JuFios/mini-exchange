import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { JwtStrategy } from '../strategies/jwt.strategy';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly strategy: JwtStrategy) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Passport реєструє іменовану стратегію глобально. Запит має перевіряти сесію через
    // репозиторій свого застосунку, навіть якщо інша репліка в цьому процесі закривається.
    const request = context.switchToHttp().getRequest<Request>();
    request.user = await this.strategy.authenticate(request);
    return true;
  }
}
