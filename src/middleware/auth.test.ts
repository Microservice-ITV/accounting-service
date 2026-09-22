import assert from 'node:assert/strict';
import test from 'node:test';
import type { Request, Response } from 'express';
import { requireExpenseAuth } from './auth.js';

const originalFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('rejects approval requests without authentication', async () => {
  const result = await new Promise<{ statusCode: number; body: unknown }>((resolve) => {
    const response = {
      statusCode: 200,
      status(statusCode: number) {
        this.statusCode = statusCode;
        return this;
      },
      json(body: unknown) {
        resolve({ statusCode: this.statusCode, body });
      },
    } as Response & { statusCode: number };

    requireExpenseAuth({ headers: {} } as Request, response, () => {
      resolve({ statusCode: 200, body: 'next' });
    });
  });

  assert.equal(result.statusCode, 401);
  assert.deepEqual(result.body, { error: 'Unauthenticated' });
});