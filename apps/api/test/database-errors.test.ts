import assert from 'node:assert/strict';
import { test } from 'node:test';
import { databaseError } from '../src/database/errors.js';
import { AppError } from '../src/errors.js';
import { ErrorCode } from '@caseflow/schemas';

test('preserves application errors without losing status or code', () => {
  const original = new AppError(ErrorCode.NotFound, 404, 'Case not found.');

  assert.equal(databaseError(original), original);
});

test('only translates known messages raised by application database functions', () => {
  const denied = databaseError({ code: 'P0001', message: 'FORBIDDEN' });

  assert.equal(denied.status, 403);
  assert.equal(denied.code, 'FORBIDDEN');
  assert.equal(databaseError({ code: '42501', message: 'FORBIDDEN' }).status, 503);
});

test('unexpected failure values return a safe service error', () => {
  for (const failure of [
    null,
    undefined,
    'private diagnostic',
    42,
    {},
    { code: 'P0001', message: 'private diagnostic' },
    new Error('private diagnostic'),
  ]) {
    const result = databaseError(failure);

    assert.equal(result.status, 503);
    assert.equal(result.code, 'SERVICE_UNAVAILABLE');
    assert.ok(!result.message.includes('private diagnostic'));
  }
});

test('constraint failures do not disclose table names or supplied values', () => {
  for (const code of ['23503', '23514', '22P02']) {
    const result = databaseError({ code, message: 'private diagnostic' });

    assert.equal(result.status, 400);
    assert.equal(result.code, 'INVALID_INPUT');
    assert.ok(!result.message.includes('private diagnostic'));
  }
});

test('processing conflicts return a safe conflict response', () => {
  const result = databaseError({ code: 'P0001', message: ErrorCode.ProcessingConflict });
  assert.equal(result.status, 409);
  assert.equal(result.code, ErrorCode.ProcessingConflict);
});
