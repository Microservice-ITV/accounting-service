import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import test from 'node:test';
import type { AddressInfo } from 'node:net';

import app from '../../app.js';
import prisma from '../../lib/prisma.js';

type HttpResult = { statusCode: number; body: string };

const originalFetch = globalThis.fetch;

function accessContextResponse(shopIds: string[]) {
  return new Response(JSON.stringify({
    data: {
      user: { id: 'approval-status-viewer' },
      access_context: {
        shops: shopIds.map((shopId) => ({ shop_id: shopId, membership_status: 'active' })),
      },
    },
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function requestApprovalStatus(port: number, expenseId: string, token?: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: '127.0.0.1',
      port,
      path: `/api/v1/expenses/${expenseId}/approval-status`,
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        statusCode: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('approval status requires authentication and same-shop authorization', async () => {
  const shopId = `approval-status-route-${Date.now()}`;
  const office = await prisma.expenseCategory.findUnique({ where: { code: 'OFFICE' } });
  assert.ok(office, 'the OFFICE expense category is required');

  const expense = await prisma.expense.create({
    data: {
      expenseNo: `APPROVAL-STATUS-${Date.now()}`,
      shopId,
      sellerUserId: 'approval-status-seller',
      expenseTypeId: office.id,
      amount: 1000,
      status: 'PENDING_APPROVAL',
    },
  });
  const approval = await prisma.expenseApproval.create({
    data: {
      expenseId: expense.id,
      stepNo: 1,
      approverUserId: 'approval-status-approver',
      status: 'PENDING',
      action: 'SUBMITTED',
    },
  });

  globalThis.fetch = (async (_input, init) => {
    const token = new Headers(init?.headers).get('authorization');
    if (token === 'Bearer allowed') return accessContextResponse([shopId]);
    if (token === 'Bearer outside') return accessContextResponse(['other-shop']);
    return accessContextResponse([]);
  }) as typeof fetch;

  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  try {
    const unauthenticated = await requestApprovalStatus(port, expense.id);
    assert.equal(unauthenticated.statusCode, 401);

    const allowed = await requestApprovalStatus(port, expense.id, 'allowed');
    assert.equal(allowed.statusCode, 200, allowed.body);
    assert.equal(JSON.parse(allowed.body).approvals[0].id, approval.id);

    const outsideShop = await requestApprovalStatus(port, expense.id, 'outside');
    assert.equal(outsideShop.statusCode, 403);

    const withoutShopAccess = await requestApprovalStatus(port, expense.id, 'no-shop');
    assert.equal(withoutShopAccess.statusCode, 403);

    const validExpense = await requestApprovalStatus(port, expense.id, 'allowed');
    assert.equal(validExpense.statusCode, 200);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await prisma.expenseApproval.delete({ where: { id: approval.id } });
    await prisma.expense.delete({ where: { id: expense.id } });
    globalThis.fetch = originalFetch;
  }
});