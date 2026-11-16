import { UnauthorizedException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { AuthService } from './auth.service';
import type { JwtPayload } from './strategies/jwt.strategy';
import type { Role } from './guards/roles.guard';

/** Перевірка claims access-токена; спільна для HTTP і WebSocket. */
export async function accessPrincipal(
  payload: JwtPayload,
  auth: AuthService,
  beforeSession?: (payload: JwtPayload) => Promise<void>,
) {
  if (
    payload?.typ !== 'access' ||
    !isUUID(payload.sub) ||
    !isUUID(payload.sid) ||
    typeof payload.email !== 'string' ||
    !Number.isInteger(payload.exp) ||
    (payload.roles !== undefined &&
      (!Array.isArray(payload.roles) || payload.roles.some((role) => role !== 'admin')))
  ) {
    throw new UnauthorizedException('Некоректний токен доступу');
  }
  if (beforeSession) await beforeSession(payload);
  const adminRequested = payload.roles?.includes('admin') && auth.isAdminEmail(payload.email);
  if (
    !(await auth.isSessionActive(
      payload.sub,
      payload.sid,
      adminRequested ? payload.email : undefined,
    ))
  ) {
    throw new UnauthorizedException('Сесію оновлення відкликано');
  }
  // Роль у claims лише показує, що токен видано адміну. Без звірки з ADMIN_EMAILS прибрана
  // адреса лишалася б адміном до `exp`.
  const roles: Role[] | undefined = adminRequested ? ['admin'] : undefined;
  return { userId: payload.sub, email: payload.email, roles };
}
