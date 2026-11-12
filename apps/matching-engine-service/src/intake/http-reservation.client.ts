import {
  ConflictException,
  InternalServerErrorException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reservation, ReservationClient } from './reservation.client';

const RESERVE_ATTEMPTS = 3;
const unavailable = () => new ServiceUnavailableException('Сервіс резервування недоступний');

export class HttpReservationClient extends ReservationClient {
  private readonly logger = new Logger(HttpReservationClient.name);
  private readonly url: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(config: ConfigService) {
    super();
    this.url = config.getOrThrow('SETTLEMENT_URL');
    this.token = config.getOrThrow('INTERNAL_API_TOKEN');
    this.timeoutMs = config.getOrThrow('RESERVATION_TIMEOUT_MS');
  }

  async reserve(request: Reservation): Promise<'accepted' | 'rejected'> {
    for (let attempt = 0; attempt < RESERVE_ATTEMPTS; attempt++) {
      let result: { status?: string; code?: string };
      let status: number;
      try {
        const response = await this.post('/internal/reservations', request);
        status = response.status;
        result = (await response.json()) ?? {};
      } catch {
        continue;
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

  private post(path: string, body?: Reservation): Promise<Response> {
    return fetch(new URL(path, this.url), {
      method: 'POST',
      redirect: 'error',
      headers: {
        'x-internal-token': this.token,
        ...(body && { 'content-type': 'application/json' }),
      },
      body: body && JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
  }
}
