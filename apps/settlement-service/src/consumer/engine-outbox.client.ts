import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { InvalidEventError } from './settlement-event';

export interface CommittedEvent {
  position: string;
  envelope: string;
}

@Injectable()
export class EngineOutboxClient {
  private readonly url: string;
  private readonly token: string;
  constructor(config: ConfigService) {
    this.url = config.getOrThrow('ENGINE_INTERNAL_URL');
    this.token = config.getOrThrow('OUTBOX_READ_TOKEN');
  }

  async event(raw: string | undefined): Promise<CommittedEvent> {
    let id: unknown;
    try {
      id = JSON.parse(raw ?? '').eventId;
    } catch {
      /* Перевірка нижче відхиляє JSON. */
    }
    if (!isUUID(id)) throw new InvalidEventError('Invalid event ID');
    return this.read<CommittedEvent>(`events/${id}`);
  }

  trade(id: string): Promise<CommittedEvent> {
    return this.read(`trades/${id}`);
  }

  async page(instrument: string, after: string, signal?: AbortSignal): Promise<CommittedEvent[]> {
    return (
      await this.read<{ events: CommittedEvent[] }>(
        `page?instrument=${encodeURIComponent(instrument)}&after=${encodeURIComponent(after)}`,
        signal,
      )
    ).events;
  }

  async assertCompensation(id: string): Promise<void> {
    if (!(await this.read<{ allowed: boolean }>(`compensation/${id}`)).allowed)
      throw new InvalidEventError('Intake has not authorized compensation');
  }

  private async read<T>(path: string, signal?: AbortSignal): Promise<T> {
    let response: Response;
    try {
      const deadline = AbortSignal.timeout(3000);
      response = await fetch(new URL(`/internal/outbox/${path}`, this.url), {
        redirect: 'error',
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
        headers: { 'x-internal-token': this.token },
      });
      if (response.status === 404) throw new InvalidEventError('Event is not committed');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return (await response.json()) as T;
    } catch (error) {
      if (error instanceof InvalidEventError) throw error;
      throw new ServiceUnavailableException('Журнал engine тимчасово недоступний');
    }
  }
}
