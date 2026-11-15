import { UnauthorizedException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AuthService } from './auth.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import type { Role } from './guards/roles.guard';

/** Перевірка claims access-токена; спільна для HTTP і WebSocket. */
export async function accessPrincipal(payload: JwtPayload, auth: AuthService) {
  if (
    payload?.typ !== 'access' ||
    !isUUID(payload.sub) ||
    !isUUID(payload.sid) ||
    typeof payload.email !== 'string' ||
    !Number.isInteger(payload.exp)
  ) {
    throw new UnauthorizedException('Некоректний токен доступу');
  }
  if (!(await auth.isSessionActive(payload.sub, payload.sid))) {
    throw new UnauthorizedException('Сесію оновлення відкликано');
  }
  // Роль у claims лише показує, що токен видано адміну. Без звірки з ADMIN_EMAILS прибрана
  // адреса лишалася б адміном до `exp`.
  const roles: Role[] | undefined =
    Array.isArray(payload.roles) &&
    payload.roles.includes('admin') &&
    auth.isAdminEmail(payload.email)
      ? ['admin']
      : undefined;
  return { userId: payload.sub, email: payload.email, roles };
}
