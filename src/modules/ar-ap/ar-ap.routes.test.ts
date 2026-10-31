import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import type { Request, RequestHandler } from 'express';
import type { AuthenticatedExpenseContext } from '../../middleware/auth.js';
import { createArApRouter } from './ar-ap.routes.js';
import {
  ArApService,
  type ArApLedgerLine,
  type ArApScope,
  type ArApSettlement,
  type IArApRepository,
} from './services/ar-ap.service.js';

const shopContext = (shopId = 'shop-1'): AuthenticatedExpenseContext => ({
  userId: 'seller-1',
  role: 'shop_admin',
  activeShopId: shopId,
  authorizedShopIds: [shopId],
  shops: [],
});

const line = (overrides: Partial<ArApLedgerLine> & {
  accountCode: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: number;
  referenceType: string;
  referenceId: string;
}): ArApLedgerLine => {
  const { accountCode, referenceType, referenceId, direction, amount, ...lineOverrides } = overrides;
  return {
    id: `line-${accountCode}-${referenceType}-${direction}`,
    direction,
    amount,
    currency: 'MMK',
    shopId: 'shop-1',
    memo: null,
    account: {
      code: accountCode,
      name: accountCode === '2000' ? 'Accounts Payable' : `Account ${accountCode}`,
      type: ['2000', '2100', '2200'].includes(accountCode) ? 'LIABILITY' : 'ASSET',
    },
    journalEntry: {
      id: `journal-${referenceType}-${referenceId}`,
      referenceType,
      referenceId,
      eventId: null,
      narration: null,
      entryDate: new Date('2026-06-15T00:00:00.000Z'),
      createdAt: new Date('2026-06-15T00:00:00.000Z'),
      status: 'POSTED',
    },
    ...lineOverrides,
  };
};

const settlement: ArApSettlement = {
  paymentReference: 'payment-1',
  orderId: 'order-1',
  checkoutId: null,
  eventId: 'payment.collected:event-1',
  currency: 'MMK',
  totalAmount: 100,
  status: 'POSTED',
  createdAt: new Date('2026-06-15T00:00:00.000Z'),
  lines: [{ shopId: 'shop-1', grossAmount: 100, payableAmount: 100, currency: 'MMK' }],
};

const createRepository = (ledgerLines: ArApLedgerLine[], settlements: ArApSettlement[] = [settlement]) => {
  const requestedScopes: ArApScope[] = [];
  const repository: IArApRepository = {
    getPostedLedgerLines: async (scope) => {
      requestedScopes.push(scope);
      return ledgerLines;
    },
    getSettlementRecords: async (scope) => {
      requestedScopes.push(scope);
      return settlements;
    },
  };
  return { repository, requestedScopes };
};

test('summary separates currencies and COD clearing from receivables without asserting payment', async () => {
  const ledgerLines = [
    line({
      accountCode: '1100',
      direction: 'DEBIT',
      amount: 100,
      referenceType: 'AR_CONTROL_TEST',
      referenceId: 'invoice-control-1',
    }),
    line({
      accountCode: '1200',
      direction: 'DEBIT',
      amount: 80,
      referenceType: 'COD_ORDER_CONFIRMED',
      referenceId: 'order-1:shop-1',
      memo: 'order=order-1',
    }),
    line({
      accountCode: '1200',
      direction: 'CREDIT',
      amount: 80,
      referenceType: 'COD_DELIVERY_COLLECTION',
      referenceId: 'order-1:shop-1',
      memo: 'order=order-1',
    }),
    line({ accountCode: '1200', direction: 'DEBIT', amount: 20, referenceType: 'COD_ORDER_CONFIRMED', referenceId: 'order-usd:shop-1', currency: 'USD' }),
    line({ accountCode: '1210', direction: 'DEBIT', amount: 80, referenceType: 'COD_DELIVERY_COLLECTION', referenceId: 'order-1:shop-1' }),
    line({ accountCode: '1210', direction: 'CREDIT', amount: 80, referenceType: 'COD_BANK_RECEIPT', referenceId: 'payment-1:shop-1' }),
    line({ accountCode: '1010', direction: 'DEBIT', amount: 80, referenceType: 'COD_BANK_RECEIPT', referenceId: 'payment-1:shop-1' }),
    line({ accountCode: '2200', direction: 'CREDIT', amount: 80, referenceType: 'COD_ORDER_CONFIRMED', referenceId: 'order-1:shop-1' }),
    line({ accountCode: '1200', direction: 'DEBIT', amount: 500, referenceType: 'COD_REVENUE', referenceId: 'other-order:shop-2', shopId: 'shop-2' }),
  ];
  const { repository, requestedScopes } = createRepository(ledgerLines);
  const service = new ArApService(repository, undefined, () => new Date('2026-06-20T00:00:00.000Z'));

  const report = await service.getSummary(shopContext(), {});

  assert.deepEqual(requestedScopes, [{ shopIds: ['shop-1'] }, { shopIds: ['shop-1'] }]);
  assert.equal(report.accountBalances.some((row) => (
    row.accountCode === '1100'
    && row.accountClass === 'accounts_receivable_control'
    && row.currency === 'MMK'
    && row.shopId === 'shop-1'
    && row.balance === 100
  )), true);
  assert.equal(report.accountBalances.some((row) => row.accountCode === '1200' && row.currency === 'MMK' && row.balance === 0), true);
  assert.equal(report.accountBalances.some((row) => row.accountCode === '1200' && row.currency === 'USD' && row.balance === 20), true);
  assert.equal(report.accountBalances.some((row) => (
    row.accountCode === '1200'
    && row.accountClass === 'cod_receivable_control'
    && row.currency === 'USD'
    && row.balance === 20
  )), true);
  assert.equal(report.accountBalances.some((row) => (
    row.accountCode === '1210'
    && row.accountClass === 'cod_collection_clearing'
    && row.currency === 'MMK'
    && row.balance === 0
  )), true);
  assert.equal(report.accountBalances.some((row) => row.accountCode === '2200' && row.bucket === 'deferred_revenue' && row.balance === 80), true);
  assert.equal(report.accountBalances.some((row) => row.accountCode === '1200' && row.balance === 500), false);
  assert.equal(report.accountBalances.some((row) => row.shopId === 'shop-2'), false);
  assert.equal(report.receivableItems.find((item) => item.orderId === 'order-1')?.status, 'CLEARED_FROM_RECEIVABLE_NOT_PROOF_OF_PAYMENT');
  assert.equal(report.receivableItems.find((item) => item.orderId === 'order-1')?.accountClass, 'cod_receivable_control');
  assert.equal(report.receivableItems.find((item) => item.orderId === 'order-1')?.balanceBasis, 'POSTED_ACCOUNTING_JOURNAL_LINES');
  assert.equal(report.receivableItems.find((item) => item.orderId === 'order-1')?.customerId, null);
  assert.equal(report.receivableBalanceBasis, 'GL_CONTROL_ACCOUNT_BALANCE_NOT_INVOICE_LEVEL_OUTSTANDING');
  assert.equal(report.invoiceLevelOutstanding.available, false);
  assert.match(report.invoiceLevelOutstanding.reason, /no invoice-level records or verified payment allocations/);
  assert.equal(report.recordedReceipts[0]?.evidenceStatus, 'EXISTING_COURIER_COLLECTION_EVENT_NOT_INDEPENDENT_BANK_VERIFICATION');
  assert.equal(report.recordedSettlements[0]?.status, 'POSTED');
  assert.match(report.recordedSettlements[0]?.meaning ?? '', /not independent bank-remittance evidence/);
  assert.equal(report.aging.available, false);
  assert.equal(report.expectedIncome.available, false);

  const usdReport = await service.getSummary(shopContext(), { currency: 'usd' });
  assert.ok(usdReport.accountBalances.every((row) => row.currency === 'USD'));
  assert.equal(usdReport.accountBalances.some((row) => row.currency === 'MMK'), false);

  const transactions = await service.listTransactions(shopContext(), { bucket: 'receivables' });
  const transactionLines = transactions.transactions.flatMap((transaction) => transaction.lines);
  assert.equal(transactionLines.some((entry) => (
    entry.accountCode === '1100' && entry.accountClass === 'accounts_receivable_control'
  )), true);
  assert.equal(transactionLines.some((entry) => (
    entry.accountCode === '1200' && entry.accountClass === 'cod_receivable_control'
  )), true);
});

test('payable report exposes only posted liability ledger balances, not supplier-bill claims', async () => {
  const { repository } = createRepository([
    line({
      accountCode: '2000',
      direction: 'CREDIT',
      amount: 15,
      referenceType: 'COD_REVENUE',
      referenceId: 'order-1:shop-1',
      memo: 'Delivery fee payable',
    }),
    line({
      accountCode: '2000',
      direction: 'DEBIT',
      amount: 10,
      referenceType: 'EXPENSE',
      referenceId: 'EXP-1',
      memo: 'not a supported supplier-bill record',
    }),
  ], []);
  const service = new ArApService(repository);

  const report = await service.getSummary(shopContext());

  assert.equal(report.payables.accountBalances[0]?.balance, 5);
  assert.equal(report.payables.payeeIdentityAvailable, false);
  assert.equal(report.payables.obligationDetailAvailable, false);
  assert.equal(report.payables.expenseApAvailable, false);
  assert.match(report.payables.note, /not supplier-only/);
});

test('deferred COD revenue has a separate liability bucket', async () => {
  const { repository } = createRepository([
    line({
      accountCode: '2200',
      direction: 'CREDIT',
      amount: 80,
      referenceType: 'COD_ORDER_CONFIRMED',
      referenceId: 'order-1:shop-1',
    }),
  ], []);
  const service = new ArApService(repository);

  const summary = await service.getSummary(shopContext());
  const transactions = await service.listTransactions(shopContext(), { bucket: 'deferred_revenue' });

  assert.equal(summary.accountBalances[0]?.bucket, 'deferred_revenue');
  assert.equal(summary.accountBalances[0]?.balance, 80);
  assert.equal(transactions.total, 1);
  assert.equal(transactions.transactions[0]?.lines[0]?.bucket, 'deferred_revenue');
});

test('unauthorized shop filters are rejected and scoped transaction reads omit other shops', async () => {
  const authorizedLine = line({
    accountCode: '1200',
    direction: 'DEBIT',
    amount: 30,
    referenceType: 'COD_REVENUE',
    referenceId: 'order-1:shop-1',
  });
  authorizedLine.journalEntry.lines = [
    {
      id: 'line-receivable',
      direction: 'DEBIT',
      amount: 30,
      currency: 'MMK',
      shopId: 'shop-1',
      memo: null,
      account: { code: '1200', name: 'COD Receivable', type: 'ASSET' },
    },
    {
      id: 'line-revenue',
      direction: 'CREDIT',
      amount: 30,
      currency: 'MMK',
      shopId: 'shop-1',
      memo: null,
      account: { code: '4000', name: 'Revenue', type: 'INCOME' },
    },
  ];
  const { repository } = createRepository([
    authorizedLine,
    line({ accountCode: '1200', direction: 'DEBIT', amount: 90, referenceType: 'COD_REVENUE', referenceId: 'order-2:shop-2', shopId: 'shop-2' }),
  ], []);
  const service = new ArApService(repository);

  await assert.rejects(
    () => service.getSummary(shopContext(), { requestedShopId: 'shop-2' }),
    /Forbidden/,
  );
  await assert.rejects(() => service.getSummary(null), /Unauthenticated/);
  const transactions = await service.listTransactions(shopContext(), { bucket: 'receivables' });
  assert.equal(transactions.total, 1);
  assert.deepEqual(transactions.scope, { type: 'authorized_shops', shopIds: ['shop-1'] });
  assert.equal(transactions.transactions[0]?.lines.some((entry) => entry.accountCode === '4000'), true);
  assert.equal(transactions.transactions[0]?.journalCompleteness, 'AUTHORIZED_SHOP_LINES_ONLY');
});

test('summary endpoint enforces authenticated shop scope on the backend', async () => {
  const { repository } = createRepository([]);
  const app = express();
  const authenticatedAs: RequestHandler = (req, _res, next) => {
    (req as Request & { auth?: AuthenticatedExpenseContext }).auth = shopContext();
    next();
  };
  app.use('/api/v1', createArApRouter(new ArApService(repository), authenticatedAs));
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const response = await fetch(`http://127.0.0.1:${address.port}/api/v1/reports/ar-ap?shopId=shop-2`);
    assert.equal(response.status, 403);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
