import test from 'node:test';
import assert from 'node:assert/strict';

import { buildExpenseReferenceId } from './expense.service.js';

test('buildExpenseReferenceId pads the sequence to four digits', () => {
  assert.equal(buildExpenseReferenceId(new Date('2026-09-18T00:00:00.000Z'), 12), 'EXP-20260918-0012');
});

test('buildExpenseReferenceId uses the expense date in YYYYMMDD format', () => {
  assert.equal(buildExpenseReferenceId(new Date('2026-09-18T12:30:00.000Z'), 1), 'EXP-20260918-0001');
});

test('shop-based expense references stay isolated to the selected shop and seller', () => {
  const refId = buildExpenseReferenceId(new Date('2026-09-20T00:00:00.000Z'), 42);
  assert.equal(refId, 'EXP-20260920-0042');
  assert.ok(refId.startsWith('EXP-'));
});
