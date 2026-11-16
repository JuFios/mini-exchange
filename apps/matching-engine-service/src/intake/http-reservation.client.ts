import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import { Reservation, ReservationClient } from './reservation.client';

const RESERVE_ATTEMPTS = 3;
const ACTIVATION_TIMEOUT_MS = 60_000;
const unavailable = () => new ServiceUnavailableException('Сервіс резервування недоступний');

export class HttpReservationClient extends ReservationClient {
  private readonly logger = new Logger(HttpReservationClient.name);
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.url = config.getOrThrow('SETTLEMENT_URL');
    this.token = config.getOrThrow('RESERVATION_API_TOKEN');
    this.timeoutMs = config.getOrThrow('RESERVATION_TIMEOUT_MS');
  }

  async assertReady(): Promise<void> {
    // Під час першого запуску settlement і engine стартують паралельно. Чекаємо поза TX.
    const deadline = AbortSignal.timeout(ACTIVATION_TIMEOUT_MS);
    for (;;) {
      try {
        const response = await fetch(new URL('/ready', this.url), {
          redirect: 'error',
          signal: AbortSignal.any([deadline, AbortSignal.timeout(this.timeoutMs)]),
        });
        if ((await response.json())?.status === 'ok' && response.status === 200) break;
      } catch {
        // До дедлайну settlement ще може закінчувати запуск.
      }
      await delay(250, undefined, { signal: deadline }).catch(() => {
        throw new Error('Settlement is unavailable before enabling reservations');
      });
    }

    // Існуючий маршрут спочатку звіряє внутрішній токен, а потім відхиляє невалідний UUID.
    // Це працює зі старою версією settlement і не викликає жодного запису.
    const response = await this.post('/internal/reservations/readiness-probe/release').catch(
      () => undefined,
    );
    const validation = await response?.json().catch(() => undefined);
    if (
      response?.status !== 400 ||
      validation?.statusCode !== 400 ||
      validation?.message !== 'Validation failed (uuid is expected)'
    )
      throw new Error('Settlement did not accept the reservation credentials');
  }

  async reserve(request: Reservation, signal?: AbortSignal): Promise<'accepted' | 'rejected'> {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS && !signal?.aborted; attempt++) {
      let response: Response;
      try {
        response = await this.post('/internal/reservations', request, signal);
      } catch {
        continue;
      }
      const { status } = response;
      // Відповідь класифікується за статусом: 401 від проксі текстом — така сама відмова.
      // Нерозібране тіло успішної відповіді — обрив, результат невідомий, а повтор ідемпотентний.
      let result: { status?: string; code?: string };
      try {
        result = (await response.json()) ?? {};
      } catch {
        if (response.ok) continue;
        result = {};
      }
      if (status === 201 && result.status === 'accepted') return 'accepted';
      if (status === 422 && result.code === 'INSUFFICIENT_FUNDS') return 'rejected';
      if (status === 409 && result.code === 'ALREADY_RELEASED') {
        throw new ConflictException({
          code: 'REQUEST_EXPIRED',
          message: 'Час прийому заявки вичерпано',
        });
      }
      // Повторюємо лише те, що минає саме: збій мережі, 5xx і 429. Інша відповідь (401 через
      // токен, 400 чи 409 через розбіжність контракту) не зміниться від повтору, тож це не
      // недоступність сервісу, а помилка конфігурації, яку має бути видно в журналі.
      if (status < 500 && status !== 429) {
        this.logger.error({
          alert: 'reservation_request_refused',
          status,
          code: result.code,
          reservationId: request.reservationId,
        });
        throw new InternalServerErrorException('Не вдалося зарезервувати кошти');
      }
    }
    throw unavailable();
  }

  async release(reservationId: string): Promise<void> {
    try {
      const response = await this.post(`/internal/reservations/${reservationId}/release`);
      const body = await response.json();
      if (response.status === 200 && body?.status === 'released') return;
    } catch {
      // Сапер повторить release, якщо його результат невідомий.
    }
    throw unavailable();
  }

  private post(path: string, body?: Reservation, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    return fetch(new URL(path, this.url), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-internal-token': this.token,
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }
}
