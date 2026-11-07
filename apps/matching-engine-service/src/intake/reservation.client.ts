import { Injectable } from '@nestjs/common';

export interface Reservation {
  reservationId: string;
  userId: string;
  asset: string;
  amount: string;
}

export abstract class ReservationClient {
  abstract reserve(request: Reservation): Promise<'accepted' | 'rejected'>;
}

@Injectable()
export class NoopReservationClient extends ReservationClient {
  async reserve(_request: Reservation): Promise<'accepted'> {
    return 'accepted';
  }
}
