import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { Request, RequestHandler } from 'express';

import {
  buildProfitLossResponse,
  resolveRequestedShopScope,
  resolveSellerShopScope,
  ProfitLossService,
} from './services/profit-loss.service.js';
import type {
  ProfitLossQuery,
  ProfitLossQueryData,
  ProfitLossResponse,
  ScopedProfitLossQuery,
} from './profit-loss.types.js';
import type { IProfitLossRepository } from './interfaces/profit-loss.repository.interface.js';
import type { IProfitLossService } from './interfaces/profit-loss.service.interface.js';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import { createProfitLossRouter } from './profit-loss.routes.js';

const authenticatedAs = (context: AuthenticatedExpenseContext): RequestHandler =>
  (req, _res, next) => {
    (req as Request & { auth?: AuthenticatedExpenseContext }).auth = context;
    next();
  };

const query: ScopedProfitLossQuery = {
  from: new Date('2026-06-01T00:00:00.000Z'),
  to: new Date('2026-07-01T00:00:00.000Z'),
  groupBy: 'month' as const,
  scope: { shopIds: ['shop-1'] },
};

const sales = (overrides: Partial<ProfitLossQueryData['salesProjections'][number]> = {}) => ({
  orderId: 'order-a',
  shopId: 'shop-1',
  currency: 'MMK',
  grossItemSales: 100,
  discountTotal: 20,
  shippingTotal: 10,
  paidAmount: 90,
  discountAllocationsComplete: true,
  orderPaidAt: new Date('2026-06-15T12:00:00.000Z'),
  discounts: [
    { discountType: 'ITEM', fundedBy: 'SELLER', amount: 10 },
    { discountType: 'ITEM', fundedBy: 'PLATFORM', amount: 5 },
    { discountType: 'SHIPPING', fundedBy: 'SELLER', amount: 3 },
    { discountType: 'SHIPPING', fundedBy: 'PLATFORM', amount: 2 },
  ],
  ...overrides,
});

const emptyData = (): ProfitLossQueryData => ({
  salesProjections: [],
  paymentLines: [],
  expenses: [],
  entries: [],
});

const createService = () => new ProfitLossService({
  getProfitLossData: async () => emptyData(),
});

test('service resolves and validates requested shop scope before repository access', async () => {
  let repositoryQuery: ScopedProfitLossQuery | undefined;
  const service = new ProfitLossService({
    getProfitLossData: async (repositoryInput) => {
      repositoryQuery = repositoryInput;
      return emptyData();
    },
  });
  const request: ProfitLossQuery = {
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
    requestedShopId: ' shop-2 ',
  };
  const context = {
    role: 'shop_admin',
    activeShopId: 'shop-1',
    authorizedShopIds: ['shop-1', 'shop-2'],
  };

  await service.getProfitLoss(request, context);
  assert.deepEqual(repositoryQuery?.scope, { shopIds: ['shop-2'] });
  await assert.rejects(
    () => service.getProfitLoss({ ...request, requestedShopId: 'shop-3' }, context),
    /Forbidden/,
  );
});

test('service filters journal entries to the authenticated shop scope', async () => {
  const data = emptyData();
  data.expenses = [
    {
      expenseNo: 'EXP-1',
      shopId: 'shop-1',
      scope: 'SHOP',
      status: 'APPROVED',
      currency: 'MMK',
      amount: 10,
      expenseDate: new Date('2026-06-05T00:00:00.000Z'),
    },
    {
      expenseNo: 'EXP-2',
      shopId: 'shop-2',
      scope: 'SHOP',
      status: 'APPROVED',
      currency: 'MMK',
      amount: 10,
      expenseDate: new Date('2026-06-05T00:00:00.000Z'),
    },
  ];
  data.entries = [
    {
      direction: 'DEBIT',
      amount: 10,
      memo: null,
      journalEntry: { referenceType: 'EXPENSE', referenceId: 'EXP-1' },
      account: { type: 'EXPENSE' },
    },
    {
      direction: 'DEBIT',
      amount: 10,
      memo: null,
      journalEntry: { referenceType: 'EXPENSE', referenceId: 'EXP-2' },
      account: { type: 'EXPENSE' },
    },
    {
      direction: 'CREDIT',
      amount: 75,
      memo: 'shop_id=shop-1',
      journalEntry: { referenceType: 'PAYMENT', referenceId: 'PAY-1' },
      account: { type: 'INCOME' },
    },
    {
      direction: 'CREDIT',
      amount: 12,
      memo: 'Delivery fee payable (MMK) (order=ORDER-1, shop=shop-1)',
      journalEntry: { referenceType: 'PAYMENT', referenceId: 'PAY-1' },
      account: { type: 'LIABILITY', code: '2000' },
    },
    {
      direction: 'CREDIT',
      amount: 925,
      memo: 'shop_id=shop-2',
      journalEntry: { referenceType: 'PAYMENT', referenceId: 'PAY-2' },
      account: { type: 'INCOME' },
    },
    {
      direction: 'CREDIT',
      amount: 20,
      memo: 'Delivery fee payable (MMK) (order=ORDER-2, shop=shop-2)',
      journalEntry: { referenceType: 'PAYMENT', referenceId: 'PAY-2' },
      account: { type: 'LIABILITY', code: '2000' },
    },
    {
      direction: 'CREDIT',
      amount: 50,
      memo: 'Other payable (shop=shop-1)',
      journalEntry: { referenceType: 'PAYMENT', referenceId: 'PAY-1' },
      account: { type: 'LIABILITY', code: '2000' },
    },
  ];
  data.paymentLines = [
    {
      shopId: 'shop-1',
      currency: 'MMK',
      grossAmount: 87,
      settlement: {
        paymentReference: 'PAY-1',
        orderId: 'ORDER-1',
        createdAt: new Date('2026-06-05T00:00:00.000Z'),
      },
    },
    {
      shopId: 'shop-2',
      currency: 'MMK',
      grossAmount: 945,
      settlement: {
        paymentReference: 'PAY-2',
        orderId: 'ORDER-2',
        createdAt: new Date('2026-06-05T00:00:00.000Z'),
      },
    },
  ];
  const service = new ProfitLossService({
    getProfitLossData: async () => data,
  });

  const response = await service.getProfitLoss({
    from: query.from,
    to: query.to,
    groupBy: query.groupBy,
  }, {
    role: 'shop_admin',
    activeShopId: 'shop-1',
    authorizedShopIds: ['shop-1'],
  });

  assert.deepEqual(
    response.entries.map((entry) => entry.journalEntry.referenceId),
    ['EXP-1', 'PAY-1', 'PAY-1'],
  );
  assert.deepEqual(
    response.entries
      .filter((entry) => entry.account.code === '2000')
      .map((entry) => entry.amount),
    [12],
  );
  assert.equal(
    response.entries.find((entry) => entry.account.code === '2000')?.currency,
    'MMK',
  );
});

test('controller hides unexpected repository errors from HTTP responses', async () => {
  const service: IProfitLossService = {
    getProfitLoss: async (_request: ProfitLossQuery): Promise<ProfitLossResponse> => {
      throw new Error('database connection details');
    },
  };
  const app = express();
  app.use('/api/v1', createProfitLossRouter(
    service,
    authenticatedAs({
      userId: 'seller-1',
      role: 'shop_admin',
      activeShopId: 'shop-1',
      authorizedShopIds: ['shop-1'],
      shops: [],
    }),
  ));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/reports/profit-loss`);
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to generate report' });
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('seller-funded item discount reduces expected net sales', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [sales()],
  });

  assert.equal(response.reports[0].revenue.grossSales, 100);
  assert.equal(response.reports[0].revenue.discounts, 10);
  assert.equal(response.reports[0].revenue.netSales, 90);
});

test('platform-funded item discount is not deducted from seller expected sales', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [sales({
      discounts: [{ discountType: 'ITEM', fundedBy: 'PLATFORM', amount: 20 }],
    })],
  });

  assert.equal(response.reports[0].revenue.discounts, 0);
  assert.equal(response.reports[0].revenue.netSales, 100);
  assert.equal(response.reports[0].revenue.platformFundedItemDiscounts, 20);
});

test('item and shipping discounts stay separate and only item discounts affect expected net sales', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [sales()],
  });
  const revenue = response.reports[0].revenue;

  assert.equal(revenue.discounts, 10);
  assert.equal(revenue.sellerFundedShippingDiscounts, 3);
  assert.equal(revenue.platformFundedShippingDiscounts, 2);
  assert.equal(revenue.platformFundedItemDiscounts, 5);
  assert.equal(revenue.netSales, 90);
});

test('discount totals are unavailable when promotion allocations are incomplete', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [sales({ discountAllocationsComplete: false })],
  });

  assert.equal(response.reports[0].revenue.discounts, null);
  assert.equal(response.reports[0].revenue.netSales, null);
  assert.ok(response.reports[0].missingComponents.includes('discountAllocations'));
});

test('shop scope attributes paid amount less shipping as recognized revenue only to the selected shop', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [
      sales({ shopId: 'shop-1', grossItemSales: 100 }),
      sales({ shopId: 'shop-2', grossItemSales: 900 }),
    ],
    paymentLines: [
      {
        shopId: 'shop-1', currency: 'MMK', grossAmount: 75,
        settlement: { paymentReference: 'pay-a', orderId: null, createdAt: new Date('2026-06-15T12:00:00.000Z') },
      },
      {
        shopId: 'shop-2', currency: 'MMK', grossAmount: 925,
        settlement: { paymentReference: 'pay-a', orderId: null, createdAt: new Date('2026-06-15T12:00:00.000Z') },
      },
    ],
    entries: [
      {
        direction: 'CREDIT',
        amount: 80,
        memo: 'Revenue recognized (order=order-a, shop=shop-1)',
        journalEntry: { referenceType: 'PAYMENT', referenceId: 'pay-a' },
        account: { type: 'INCOME' },
      },
      {
        direction: 'CREDIT',
        amount: 925,
        memo: 'Revenue recognized (order=order-a, shop=shop-2)',
        journalEntry: { referenceType: 'PAYMENT', referenceId: 'pay-a' },
        account: { type: 'INCOME' },
      },
    ],
  });

  assert.equal(response.reports[0].revenue.grossSales, 100);
  assert.equal(response.reports[0].actualRevenue, 80);
  assert.equal(response.entries.find((entry) => entry.journalEntry.referenceId === 'pay-a')?.amount, 80);
});

test('income API corrects an existing collected COD journal to merchandise sales', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [
      sales({
        grossItemSales: 5500,
        discountTotal: 0,
        shippingTotal: 1575.88,
        paidAmount: 7075.88,
        discounts: [],
      }),
    ],
    paymentLines: [{
      shopId: 'shop-1',
      currency: 'MMK',
      grossAmount: 7075.88,
      settlement: {
        paymentReference: 'pay-cod-7075',
        orderId: null,
        createdAt: new Date('2026-06-15T12:00:00.000Z'),
      },
    }],
    entries: [{
      direction: 'CREDIT',
      amount: 7075.88,
      memo: 'Revenue recognized (MMK) (order=order-a, shop=shop-1)',
      journalEntry: { referenceType: 'PAYMENT', referenceId: 'pay-cod-7075' },
      account: { type: 'INCOME' },
    }],
  });

  assert.equal(response.entries[0].amount, 5500);
  assert.equal(response.reports[0].actualRevenue, 5500);
});

test('only approved shop expenses within the period and scope are included', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    expenses: [
      { shopId: 'shop-1', scope: 'SHOP', status: 'APPROVED', currency: 'MMK', amount: 12, expenseDate: new Date('2026-06-05T00:00:00.000Z') },
      { shopId: 'shop-1', scope: 'SHOP', status: 'PENDING', currency: 'MMK', amount: 100, expenseDate: new Date('2026-06-05T00:00:00.000Z') },
      { shopId: 'shop-1', scope: 'PLATFORM', status: 'APPROVED', currency: 'MMK', amount: 200, expenseDate: new Date('2026-06-05T00:00:00.000Z') },
      { shopId: 'shop-2', scope: 'SHOP', status: 'APPROVED', currency: 'MMK', amount: 300, expenseDate: new Date('2026-06-05T00:00:00.000Z') },
      { shopId: 'shop-1', scope: 'SHOP', status: 'APPROVED', currency: 'MMK', amount: 400, expenseDate: new Date('2026-07-01T00:00:00.000Z') },
    ],
  });

  assert.equal(response.reports[0].expenses.operatingExpenses, 12);
  assert.equal(response.reports[0].profit.currentProfitOrLoss, -12);
});

test('tax, refunds, COGS, payment fees and commission remain unavailable rather than zero', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [sales()],
  });
  const report = response.reports[0];

  assert.equal(response.complete, false);
  assert.equal(response.tax, null);
  assert.equal(response.refunds, null);
  assert.equal(response.cogs, null);
  assert.equal(response.paymentFees, null);
  assert.equal(response.commission, null);
  assert.equal(report.revenue.tax, null);
  assert.equal(report.revenue.refunds, null);
  assert.equal(report.expenses.cogs, null);
  assert.equal(report.expenses.paymentFees, null);
  assert.equal(report.expenses.commission, null);
  assert.ok(['tax', 'refunds', 'cogs', 'paymentFees', 'commission'].every(
    (component) => report.missingComponents.includes(component),
  ));
});

test('currency totals are not combined when transactions use different currencies', () => {
  const response = buildProfitLossResponse(query, {
    ...emptyData(),
    salesProjections: [
      sales({ currency: 'MMK' }),
      sales({ shopId: 'shop-1', currency: 'USD' }),
    ],
  });

  assert.equal(response.reports.length, 2);
  assert.equal(response.totalIncome, null);
  assert.equal(response.totalExpense, null);
  assert.equal(response.netProfit, null);
});

test('missing shop authorization and a requested unauthorized shop are rejected', () => {
  assert.throws(() => resolveSellerShopScope(null), /Unauthenticated/);
  const scope = resolveSellerShopScope({
    role: 'shop_admin',
    activeShopId: 'shop-1',
    authorizedShopIds: ['shop-1', 'shop-2'],
  });
  assert.deepEqual(scope.shopIds, ['shop-1', 'shop-2']);
  assert.deepEqual(resolveRequestedShopScope(scope, 'shop-2').shopIds, ['shop-2']);
  assert.throws(
    () => resolveRequestedShopScope(scope, 'shop-3'),
    /Forbidden/,
  );
});

test('report endpoint rejects unauthenticated access and an unauthorized shop request', async () => {
  const repository: IProfitLossRepository = {
    getProfitLossData: async () => emptyData(),
  };
  const app = express();
  app.use('/api/v1', createProfitLossRouter(
    new ProfitLossService(repository),
    authenticatedAs({
      userId: 'seller-1',
      role: 'shop_admin',
      activeShopId: 'shop-1',
      authorizedShopIds: ['shop-1'],
      shops: [],
    }),
  ));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}/api/v1/reports/profit-loss`;

  try {
    const unauthorizedShop = await fetch(`${baseUrl}?shopId=shop-2`);
    assert.equal(unauthorizedShop.status, 403);

    const unauthenticatedApp = express();
    unauthenticatedApp.use('/api/v1', createProfitLossRouter(
      createService(),
      (_req, res) => { res.status(401).json({ error: 'Unauthenticated' }); },
    ));
    const unauthenticatedServer = createServer(unauthenticatedApp);
    await new Promise<void>((resolve) => unauthenticatedServer.listen(0, '127.0.0.1', resolve));
    const unauthenticatedAddress = unauthenticatedServer.address();
    assert.ok(unauthenticatedAddress && typeof unauthenticatedAddress !== 'string');
    try {
      const response = await fetch(`http://127.0.0.1:${unauthenticatedAddress.port}/api/v1/reports/profit-loss`);
      assert.equal(response.status, 401);
    } finally {
      await new Promise<void>((resolve, reject) => unauthenticatedServer.close((error) => error ? reject(error) : resolve()));
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('platform role receives unfiltered scope while seller scope remains explicit', () => {
  assert.deepEqual(resolveSellerShopScope({
    role: 'super_admin',
    authorizedShopIds: ['shop-1'],
  }), { shopIds: null });
  assert.deepEqual(resolveSellerShopScope({
    role: 'shop_admin',
    activeShopId: null,
    authorizedShopIds: ['shop-1', 'shop-2', 'shop-2'],
  }), { shopIds: ['shop-1', 'shop-2'] });
});
