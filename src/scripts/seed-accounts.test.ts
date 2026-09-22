import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldSeedRequiredMasterData } from './seed-accounts.js';

test('development defaults to seeding required accounting data unless explicitly disabled', () => {
  const previousEnable = process.env.ACCOUNTING_ENABLE_SEED;
  const previousNodeEnv = process.env.NODE_ENV;

  try {
    delete process.env.ACCOUNTING_ENABLE_SEED;
    process.env.NODE_ENV = 'development';
    assert.equal(shouldSeedRequiredMasterData(), true);

    process.env.ACCOUNTING_ENABLE_SEED = 'false';
    assert.equal(shouldSeedRequiredMasterData(), false);

    process.env.ACCOUNTING_ENABLE_SEED = 'true';
    assert.equal(shouldSeedRequiredMasterData(), true);
  } finally {
    if (previousEnable === undefined) {
      delete process.env.ACCOUNTING_ENABLE_SEED;
    } else {
      process.env.ACCOUNTING_ENABLE_SEED = previousEnable;
    }

    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }
  }
});
