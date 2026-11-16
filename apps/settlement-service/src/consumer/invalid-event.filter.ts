import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import { NotConfirmedError } from './settlement-event';

/**
 * Engine не підтвердив операцію: угоди немає в committed outbox або intake не дозволив
 * компенсацію. Повтор того самого запиту не допоможе, тож це відмова, а не збій сервера.
 * Committed подію, яку settlement не може розібрати, лишаємо 500: це розбіжність версій.
 */
@Catch(NotConfirmedError)
export class InvalidEventFilter implements ExceptionFilter {
  catch(error: NotConfirmedError, host: ArgumentsHost) {
    host
      .switchToHttp()
      .getResponse<Response>()
      .status(409)
      .json({ statusCode: 409, code: 'NOT_COMMITTED', message: error.message });
  }
}
