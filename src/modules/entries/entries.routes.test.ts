import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import express from 'express';
import { test } from 'node:test';
import type { IEntryService } from './interfaces/entry.service.interface.js';
import { createEntriesRouter } from './entries.routes.js';

test('Entry routes preserve create, list, and not-found response shapes', async () => {
  const service: IEntryService = {
    create: async (input) => ({
      id: 'journal-1',
      referenceType: input.referenceType,
      referenceId: input.referenceId,
      eventId: input.eventId ?? null,
      narration: input.narration ?? 'Accounting entry',
      status: 'POSTED',
      lines: input.lines,
    }),
    list: async () => [],
    getByReference: async () => null,
  };
  const app = express();
  app.use(express.json());
  app.use('/api/v1', createEntriesRouter(service));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1/entries`;

  try {
    const created = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        referenceType: 'TEST',
        referenceId: 'entry-1',
        lines: [
          { accountCode: '1000', direction: 'DEBIT', amount: 10 },
          { accountCode: '4000', direction: 'CREDIT', amount: 10 },
        ],
      }),
    });
    assert.equal(created.status, 201);
    assert.deepEqual(await created.json(), {
      id: 'journal-1',
      referenceType: 'TEST',
      referenceId: 'entry-1',
      eventId: null,
      narration: 'Accounting entry',
      status: 'POSTED',
      lines: [
        { accountCode: '1000', direction: 'DEBIT', amount: 10 },
        { accountCode: '4000', direction: 'CREDIT', amount: 10 },
      ],
    });

    const missing = await fetch(baseUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ referenceType: 'TEST', referenceId: 'entry-2' }),
    });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), {
      error: 'referenceType, referenceId, and lines are required',
    });

    const notFound = await fetch(`${baseUrl}/reference/TEST/entry-1`);
    assert.equal(notFound.status, 404);
    assert.deepEqual(await notFound.json(), { error: 'Entry not found' });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  }
});
