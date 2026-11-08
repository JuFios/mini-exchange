import { ArgumentsHost, Catch } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { Response } from 'express';

@Catch()
export class DatabaseExceptionFilter extends BaseExceptionFilter {
  override catch(error: unknown, host: ArgumentsHost): void {
    const failure = error as { code?: string; driverError?: { code?: string } };
    const code = failure?.driverError?.code ?? failure?.code ?? '';
    const message = error instanceof Error ? error.message : '';
    if (
      /^08/.test(code) ||
      // Пул, клієнт pg і TypeORM повідомляють про ці збої без коду.
      /^Connection terminated|^timeout exceeded when trying to connect|already released/.test(
        message,
      ) ||
      [
        'ECONNREFUSED',
        'ECONNRESET',
        'ETIMEDOUT',
        'ENOTFOUND',
        'EAI_AGAIN',
        'EHOSTUNREACH',
        'ENETUNREACH',
        'EPIPE',
        '25P03',
        '57P01',
        '57P02',
        '57P03',
        '53300',
        '55P03',
        '57014',
      ].includes(code)
    ) {
      host
        .switchToHttp()
        .getResponse<Response>()
        .status(503)
        .json({ statusCode: 503, message: 'База даних тимчасово недоступна' });
      return;
    }
    super.catch(error, host);
  }
}
