import { Injectable } from '@nestjs/common';

export interface Reservation {
  reservationId: string;
  userId: string;
  instrument: string;
  limitPrice: string;
  asset: string;
  amount: string;
}

export abstract class ReservationClient {
  abstract reserve(request: Reservation): Promise<'accepted' | 'rejected'>;
  abstract release(reservationId: string): Promise<void>;
}

@Injectable()
export class NoopReservationClient extends ReservationClient {
  async reserve(_request: Reservation): Promise<'accepted'> {
    return 'accepted';
  }

  async release(_reservationId: string): Promise<void> {}
}
