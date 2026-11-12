import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ApiError } from '../lib/client-api';
import { reconciliationNotice } from '../lib/reconciliation';

describe('reconciliation notice', () => {
  it('shows a reconciliation that is still running as a state, not as a failure', () => {
    const notice = reconciliationNotice(new ApiError(409, 'Звірка вже виконується'));
    assert.equal(notice.failed, false);
    assert.match(notice.message, /вже виконується/);
  });

  it('reports a gateway timeout and other answers as failures', () => {
    assert.deepEqual(
      [502, 503, 504, 403].map((status) => reconciliationNotice(new ApiError(status, 'x')).failed),
      [true, true, true, true],
    );
    assert.equal(
      reconciliationNotice(new ApiError(403, 'Доступ заборонено')).message,
      'Доступ заборонено',
    );
    assert.equal(reconciliationNotice(new TypeError('fetch failed')).failed, true);
  });
});
