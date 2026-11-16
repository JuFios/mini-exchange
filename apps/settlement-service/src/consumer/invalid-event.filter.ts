import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { InvalidEventError } from './settlement-event';

/**
 * Engine не підтвердив операцію: угоди немає в committed outbox або intake не дозволив
 * компенсацію. Повтор того самого запиту не допоможе, тож це відмова, а не збій сервера.
 */
@Catch(InvalidEventError)
export class InvalidEventFilter implements ExceptionFilter {
  catch(error: InvalidEventError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(409)
      .json({ statusCode: 409, code: 'NOT_COMMITTED', message: error.message });
  }
}
