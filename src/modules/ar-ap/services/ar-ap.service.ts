import { ProfitLossAuthorizationPolicy } from '../../profit-loss/policies/profit-loss-authorization.policy.js';
import type { AuthenticatedExpenseContext } from '../../../middleware/auth.js';

export const AR_AP_ACCOUNT_CODES = ['1010', '1100', '1200', '1210', '2000', '2100', '2200'] as const;
export type ArApAccountCode = typeof AR_AP_ACCOUNT_CODES[number];
export type ArApBucket = 'receivables' | 'cod_clearing' | 'payables' | 'deferred_revenue' | 'recorded_receipts';
export type ArApAccountClass =
  | 'recorded_receipts'
  | 'accounts_receivable_control'
  | 'cod_receivable_control'
  | 'cod_collection_clearing'
  | 'payables_control'
  | 'deferred_cod_revenue'
  | 'other_journal_line';

type MoneyValue = number | string | { toString(): string };

export type ArApJournalLineDetail = {
  id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: MoneyValue;
  currency: string | null;
  shopId: string | null;
  memo: string | null;
  account: { code: string; name: string; type: string };
};

export type ArApLedgerLine = {
  id: string;
  direction: 'DEBIT' | 'CREDIT';
  amount: MoneyValue;
  currency: string | null;
  shopId: string | null;
  memo: string | null;
  account: { code: string; name: string; type: string };
  journalEntry: {
    id: string;
    referenceType: string;
    referenceId: string;
    eventId: string | null;
    narration: string | null;
    entryDate: Date | string;
    createdAt: Date | string;
    status: string;
    lines?: ArApJournalLineDetail[];
  };
};

export type ArApSettlement = {
  paymentReference: string;
  orderId: string | null;
  checkoutId: string | null;
  eventId: string | null;
  currency: string;
  totalAmount: MoneyValue;
  status: string;
  createdAt: Date | string;
  lines: Array<{
    shopId: string | null;
    grossAmount: MoneyValue;
    payableAmount: MoneyValue;
    currency: string;
  }>;
};

export type ArApScope = { shopIds: string[] | null };

export interface IArApRepository {
  getPostedLedgerLines(scope: ArApScope): Promise<ArApLedgerLine[]>;
  getSettlementRecords(scope: ArApScope): Promise<ArApSettlement[]>;
}

export type ArApQuery = {
  requestedShopId?: string;
  bucket?: ArApBucket;
  currency?: string;
  limit?: number;
  offset?: number;
  referenceType?: string;
  referenceId?: string;
};

const accountBucket: Record<ArApAccountCode, ArApBucket> = {
  '1010': 'recorded_receipts',
  '1100': 'receivables',
  '1200': 'receivables',
  '1210': 'cod_clearing',
  '2000': 'payables',
  '2100': 'payables',
  '2200': 'deferred_revenue',
};

const accountClass: Record<ArApAccountCode, ArApAccountClass> = {
  '1010': 'recorded_receipts',
  '1100': 'accounts_receivable_control',
  '1200': 'cod_receivable_control',
  '1210': 'cod_collection_clearing',
  '2000': 'payables_control',
  '2100': 'payables_control',
  '2200': 'deferred_cod_revenue',
};

function getAccountClass(code: string): ArApAccountClass {
  return AR_AP_ACCOUNT_CODES.includes(code as ArApAccountCode)
    ? accountClass[code as ArApAccountCode]
    : 'other_journal_line';
}

const accountCodesByBucket: Record<ArApBucket, readonly ArApAccountCode[]> = {
  receivables: ['1100', '1200'],
  cod_clearing: ['1210'],
  payables: ['2000', '2100'],
  deferred_revenue: ['2200'],
  recorded_receipts: ['1010'],
};

const moneyToCents = (value: MoneyValue): number => {
  const amount = Number(value.toString());
  if (!Number.isFinite(amount)) {
    throw new Error('AR/AP ledger contains a non-finite journal amount');
  }
  return Math.round(amount * 100);
};

const moneyFromCents = (value: number): number => Number((value / 100).toFixed(2));
const isoDate = (value: Date | string): string => new Date(value).toISOString();
const normalizedCurrency = (value: string | null): string | null => value?.trim().toUpperCase() || null;

function getOrderId(line: ArApLedgerLine): string | null {
  const memoOrder = line.memo?.match(/(?:^|[\s,(])order(?:_id)?=([^,\s)]+)/i)?.[1];
  if (memoOrder) return memoOrder;

  if (['COD_ORDER_CONFIRMED', 'COD_REVENUE', 'COD_DELIVERY_COLLECTION'].includes(line.journalEntry.referenceType)) {
    const suffix = line.shopId ? `:${line.shopId}` : '';
    if (suffix && line.journalEntry.referenceId.endsWith(suffix)) {
      return line.journalEntry.referenceId.slice(0, -suffix.length);
    }
  }
  return null;
}

function getPayableClassification(line: Pick<ArApLedgerLine, 'account' | 'memo'>): string {
  if (line.account.code === '2000' && /^Delivery fee payable(?:\s|$)/i.test(line.memo ?? '')) {
    return 'delivery_fee_liability_payee_unavailable';
  }
  if (line.account.code === '2100') {
    return 'seller_payables_ledger_payee_unavailable';
  }
  return 'unclassified_liability';
}

export class ArApAuthorizationError extends Error {
  constructor(message: string, public readonly statusCode: number) {
    super(message);
    this.name = 'ArApAuthorizationError';
  }
}

export class ArApService {
  constructor(
    private readonly repository: IArApRepository,
    private readonly authorizationPolicy = new ProfitLossAuthorizationPolicy(),
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private resolveScope(context: AuthenticatedExpenseContext | null, requestedShopId?: string): ArApScope {
    try {
      return this.authorizationPolicy.resolveRequestedShopScope(
        this.authorizationPolicy.resolveSellerShopScope(context),
        requestedShopId,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Forbidden';
      const status = /Unauthenticated/i.test(message) ? 401 : 403;
      throw new ArApAuthorizationError(message, status);
    }
  }

  private filterLines(lines: ArApLedgerLine[], scope: ArApScope): ArApLedgerLine[] {
    return lines.filter((line) => (
      scope.shopIds === null
      || (line.shopId !== null && scope.shopIds.includes(line.shopId))
    ));
  }

  private async getData(context: AuthenticatedExpenseContext | null, requestedShopId?: string) {
    const scope = this.resolveScope(context, requestedShopId);
    const [lines, settlements] = await Promise.all([
      this.repository.getPostedLedgerLines(scope),
      this.repository.getSettlementRecords(scope),
    ]);
    const scopedLines = this.filterLines(lines, scope);
    return {
      scope,
      lines: scopedLines,
      settlements: settlements.map((settlement) => ({
        ...settlement,
        lines: settlement.lines.filter((line) => (
          scope.shopIds === null
          || (line.shopId !== null && scope.shopIds.includes(line.shopId))
        )),
      })).filter((settlement) => settlement.lines.length > 0),
    };
  }

  async getSummary(context: AuthenticatedExpenseContext | null, query: ArApQuery = {}) {
    const data = await this.getData(context, query.requestedShopId);
    const selectedCurrency = query.currency?.trim().toUpperCase();
    const lines = data.lines.filter((line) => (
      !selectedCurrency || normalizedCurrency(line.currency) === selectedCurrency
    ));
    const settlements = data.settlements
      .filter((settlement) => !selectedCurrency || normalizedCurrency(settlement.currency) === selectedCurrency)
      .map((settlement) => ({
        ...settlement,
        lines: settlement.lines.filter((line) => (
          !selectedCurrency || normalizedCurrency(line.currency) === selectedCurrency
        )),
      }))
      .filter((settlement) => settlement.lines.length > 0);
    const { scope } = data;
    const balances = new Map<string, {
      accountCode: ArApAccountCode;
      accountName: string;
      bucket: ArApBucket;
      accountClass: ArApAccountClass;
      shopId: string | null;
      currency: string | null;
      debitCents: number;
      creditCents: number;
      lineCount: number;
    }>();
    const receivableItems = new Map<string, {
      accountCode: '1100' | '1200';
      accountClass: ArApAccountClass;
      shopId: string | null;
      currency: string | null;
      orderId: string | null;
      customerId: null;
      debitCents: number;
      creditCents: number;
      sourceReferences: Map<string, { referenceType: string; referenceId: string }>;
    }>();
    const recordedReceipts = new Map<string, {
      shopId: string | null;
      currency: string | null;
      paymentReference: string;
      orderId: string | null;
      debitCents: number;
      creditCents: number;
      journalIds: Set<string>;
      sourceReferences: Map<string, { referenceType: string; referenceId: string }>;
    }>();

    for (const line of lines) {
      const accountCode = line.account.code as ArApAccountCode;
      if (!AR_AP_ACCOUNT_CODES.includes(accountCode)) continue;
      const currency = normalizedCurrency(line.currency);
      const balanceKey = `${accountCode}\u0000${line.shopId ?? ''}\u0000${currency ?? ''}`;
      const balance = balances.get(balanceKey) ?? {
        accountCode,
        accountName: line.account.name,
        bucket: accountBucket[accountCode],
        accountClass: accountClass[accountCode],
        shopId: line.shopId,
        currency,
        debitCents: 0,
        creditCents: 0,
        lineCount: 0,
      };
      if (line.direction === 'DEBIT') balance.debitCents += moneyToCents(line.amount);
      else balance.creditCents += moneyToCents(line.amount);
      balance.lineCount += 1;
      balances.set(balanceKey, balance);

      if (accountCode === '1100' || accountCode === '1200') {
        const orderId = getOrderId(line);
        const sourceKey = orderId
          ? `order:${orderId}`
          : `reference:${line.journalEntry.referenceType}:${line.journalEntry.referenceId}`;
        const itemKey = `${accountCode}\u0000${line.shopId ?? ''}\u0000${currency ?? ''}\u0000${sourceKey}`;
        const item = receivableItems.get(itemKey) ?? {
          accountCode,
          accountClass: accountClass[accountCode],
          shopId: line.shopId,
          currency,
          orderId,
          customerId: null,
          debitCents: 0,
          creditCents: 0,
          sourceReferences: new Map(),
        };
        if (line.direction === 'DEBIT') item.debitCents += moneyToCents(line.amount);
        else item.creditCents += moneyToCents(line.amount);
        item.sourceReferences.set(
          `${line.journalEntry.referenceType}:${line.journalEntry.referenceId}`,
          { referenceType: line.journalEntry.referenceType, referenceId: line.journalEntry.referenceId },
        );
        receivableItems.set(itemKey, item);
      }

      if (accountCode === '1010' && line.direction === 'DEBIT') {
        const receiptReferenceId = line.journalEntry.referenceId;
        const shopSuffix = line.shopId ? `:${line.shopId}` : '';
        const paymentReference = line.journalEntry.referenceType === 'COD_BANK_RECEIPT'
          && shopSuffix
          && receiptReferenceId.endsWith(shopSuffix)
          ? receiptReferenceId.slice(0, -shopSuffix.length)
          : receiptReferenceId;
        const receiptKey = `${paymentReference}\u0000${line.shopId ?? ''}\u0000${currency ?? ''}`;
        const receipt = recordedReceipts.get(receiptKey) ?? {
          shopId: line.shopId,
          currency,
          paymentReference,
          orderId: getOrderId(line),
          debitCents: 0,
          creditCents: 0,
          journalIds: new Set<string>(),
          sourceReferences: new Map(),
        };
        receipt.debitCents += moneyToCents(line.amount);
        receipt.journalIds.add(line.journalEntry.id);
        receipt.sourceReferences.set(
          `${line.journalEntry.referenceType}:${line.journalEntry.referenceId}`,
          { referenceType: line.journalEntry.referenceType, referenceId: line.journalEntry.referenceId },
        );
        recordedReceipts.set(receiptKey, receipt);
      }
    }

    const accountBalances = [...balances.values()]
      .sort((left, right) =>
        left.accountCode.localeCompare(right.accountCode)
        || String(left.currency).localeCompare(String(right.currency))
        || String(left.shopId).localeCompare(String(right.shopId)),
      )
      .map(({ debitCents, creditCents, ...balance }) => ({
        ...balance,
        debit: moneyFromCents(debitCents),
        credit: moneyFromCents(creditCents),
        balance: moneyFromCents(
          ['2000', '2100', '2200'].includes(balance.accountCode)
            ? creditCents - debitCents
            : debitCents - creditCents,
        ),
        balanceMeaning: balance.accountCode === '1010'
          ? 'accounting_posted_asset_movement_not_independent_bank_verification'
          : balance.accountCode === '1210'
            ? 'cod_collection_clearing_not_customer_receivable'
            : balance.accountCode === '2200'
              ? 'deferred_cod_revenue_not_yet_collected'
            : ['2000', '2100'].includes(balance.accountCode)
              ? 'posted_liability_gl_balance_payee_may_be_unavailable'
              : 'posted_receivable_control_account_balance',
      }));

    return {
      asOf: this.clock().toISOString(),
      scope: scope.shopIds === null ? { type: 'platform' } : { type: 'authorized_shops', shopIds: scope.shopIds },
      source: 'POSTED_ACCOUNTING_JOURNAL_LINES',
      receivableBalanceBasis: 'GL_CONTROL_ACCOUNT_BALANCE_NOT_INVOICE_LEVEL_OUTSTANDING',
      invoiceLevelOutstanding: {
        available: false,
        reason: 'Accounting has no invoice-level records or verified payment allocations; receivable balances are derived only from posted GL journal lines.',
      },
      currencyPolicy: 'Balances remain separated by currency; no conversion or cross-currency totals are performed.',
      accountBalances,
      receivableItems: [...receivableItems.values()]
        .map((item) => {
          const outstandingCents = item.debitCents - item.creditCents;
          return {
            accountCode: item.accountCode,
            accountClass: item.accountClass,
            balanceBasis: 'POSTED_ACCOUNTING_JOURNAL_LINES',
            shopId: item.shopId,
            currency: item.currency,
            orderId: item.orderId,
            customerId: item.customerId,
            customerIdentityAvailable: false,
            debitRecognized: moneyFromCents(item.debitCents),
            creditsPostedToReceivable: moneyFromCents(item.creditCents),
            outstandingBalance: moneyFromCents(outstandingCents),
            status: outstandingCents < 0
              ? 'CREDIT_BALANCE_REQUIRES_REVIEW'
              : outstandingCents === 0
                ? (item.debitCents > 0 ? 'CLEARED_FROM_RECEIVABLE_NOT_PROOF_OF_PAYMENT' : 'NO_OPEN_BALANCE')
                : item.creditCents > 0 ? 'PARTIALLY_CLEARED_IN_GL' : 'OPEN',
            sourceReferences: [...item.sourceReferences.values()],
          };
        })
        .sort((left, right) =>
          String(left.currency).localeCompare(String(right.currency))
          || String(left.shopId).localeCompare(String(right.shopId))
          || String(left.orderId).localeCompare(String(right.orderId)),
        ),
      codCollectionClearing: {
        accountCode: '1210',
        balanceRows: accountBalances.filter((balance) => balance.accountCode === '1210'),
        evidenceNote: 'The current payment.collected producer indicates courier handover. Account 1010 postings are not independently verified bank remittances.',
      },
      payables: {
        accountBalances: accountBalances.filter((balance) => ['2000', '2100'].includes(balance.accountCode)),
        payeeIdentityAvailable: false,
        obligationDetailAvailable: false,
        partialSettlementAllocationAvailable: false,
        expenseApAvailable: false,
        expenseApLimitation: 'Existing approved expense journals debit an expense account and credit the funding account, not an AP control account; expense records therefore are not treated as open AP here.',
        note: 'Account 2000 includes delivery-fee payable postings and is not supplier-only. Account 2100 has no verified live posting flow in the inspected implementation. These are control-account ledger balances, not confirmed supplier bills.',
      },
      recordedSettlements: settlements.map((settlement) => ({
        paymentReference: settlement.paymentReference,
        orderId: settlement.orderId,
        checkoutId: settlement.checkoutId,
        eventId: settlement.eventId,
        status: settlement.status,
        currency: settlement.currency,
        createdAt: isoDate(settlement.createdAt),
        shopAllocations: settlement.lines.map((line) => ({
          shopId: line.shopId,
          currency: normalizedCurrency(line.currency),
          grossAmount: Number(line.grossAmount.toString()),
          payableAmount: Number(line.payableAmount.toString()),
        })),
        meaning: 'Existing Accounting settlement projection; not independent bank-remittance evidence and not an AR payment allocation.',
      })),
      recordedReceipts: [...recordedReceipts.values()].map((receipt) => ({
        shopId: receipt.shopId,
        currency: receipt.currency,
        paymentReference: receipt.paymentReference,
        orderId: receipt.orderId,
        amount: moneyFromCents(receipt.debitCents - receipt.creditCents),
        journalIds: [...receipt.journalIds],
        sourceReferences: [...receipt.sourceReferences.values()],
        evidenceStatus: [...receipt.sourceReferences.values()].some((reference) => reference.referenceType === 'COD_BANK_RECEIPT')
          ? 'EXISTING_COURIER_COLLECTION_EVENT_NOT_INDEPENDENT_BANK_VERIFICATION'
          : 'BANK_EVIDENCE_NOT_EVALUATED',
        meaning: 'Accounting journal evidence only; do not infer bank remittance without an independently verified source.',
      })),
      paymentAllocations: {
        available: false,
        reason: 'Existing settlement allocations are not linked to open receivable documents.',
      },
      expectedIncome: {
        available: false,
        reason: 'Available COD projections are used for recognized accounting entries; a separate expected-income source is not established here.',
      },
      aging: {
        available: false,
        reason: 'Invoice-level aging is unavailable because reliable invoice dates and due dates are not available in Accounting records.',
      },
      missingAttribution: lines.filter((line) => (
        ['1100', '1200', '1210', '2000', '2100'].includes(line.account.code)
        && (!line.shopId || !normalizedCurrency(line.currency))
      )).map((line) => ({
        journalId: line.journalEntry.id,
        referenceType: line.journalEntry.referenceType,
        referenceId: line.journalEntry.referenceId,
        accountCode: line.account.code,
        shopId: line.shopId,
        currency: normalizedCurrency(line.currency),
        reason: !line.shopId ? 'MISSING_SHOP_ATTRIBUTION' : 'MISSING_CURRENCY',
      })),
    };
  }

  async listTransactions(context: AuthenticatedExpenseContext | null, query: ArApQuery = {}) {
    const { scope, lines } = await this.getData(context, query.requestedShopId);
    const selectedCodes = query.bucket ? accountCodesByBucket[query.bucket] : AR_AP_ACCOUNT_CODES;
    const currency = query.currency?.trim().toUpperCase();
    const filtered = lines.filter((line) => (
      selectedCodes.includes(line.account.code as ArApAccountCode)
      && (!currency || normalizedCurrency(line.currency) === currency)
      && (!query.referenceType || line.journalEntry.referenceType === query.referenceType)
      && (!query.referenceId || line.journalEntry.referenceId === query.referenceId)
    ));
    const grouped = this.groupTransactions(filtered, scope, currency);
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    return {
      transactions: grouped.slice(offset, offset + limit),
      total: grouped.length,
      limit,
      offset,
      scope: scope.shopIds === null ? { type: 'platform' } : { type: 'authorized_shops', shopIds: scope.shopIds },
    };
  }

  async getTransaction(
    context: AuthenticatedExpenseContext | null,
    referenceType: string,
    referenceId: string,
    requestedShopId?: string,
  ) {
    const result = await this.listTransactions(context, {
      requestedShopId,
      referenceType,
      referenceId,
      limit: 200,
      offset: 0,
    });
    if (result.transactions.length === 0) {
      throw new ArApAuthorizationError('Accounting transaction not found', 404);
    }
    return result.transactions;
  }

  async getAging(context: AuthenticatedExpenseContext | null, requestedShopId?: string) {
    const scope = this.resolveScope(context, requestedShopId);
    return {
      asOf: this.clock().toISOString(),
      available: false,
      reason: 'No reliable due date or invoice date is available in the Accounting-owned COD projection and journal records.',
      buckets: null,
      scope: scope.shopIds === null ? { type: 'platform' } : { type: 'authorized_shops', shopIds: scope.shopIds },
      currencyPolicy: 'Balances remain separated by currency; no conversion or cross-currency totals are performed.',
    };
  }

  private groupTransactions(lines: ArApLedgerLine[], scope: ArApScope, currency?: string) {
    const transactions = new Map<string, ArApLedgerLine[]>();
    for (const line of lines) {
      const existing = transactions.get(line.journalEntry.id) ?? [];
      existing.push(line);
      transactions.set(line.journalEntry.id, existing);
    }
    return [...transactions.values()]
      .map((journalLines) => {
        const first = journalLines[0]!;
        return {
          journalId: first.journalEntry.id,
          referenceType: first.journalEntry.referenceType,
          referenceId: first.journalEntry.referenceId,
          eventId: first.journalEntry.eventId,
          narration: first.journalEntry.narration,
          entryDate: isoDate(first.journalEntry.entryDate),
          createdAt: isoDate(first.journalEntry.createdAt),
          status: first.journalEntry.status,
          journalCompleteness: scope.shopIds === null ? 'FULL_JOURNAL' : 'AUTHORIZED_SHOP_LINES_ONLY',
          lines: (first.journalEntry.lines ?? journalLines)
            .filter((line) => (
              (scope.shopIds === null || (line.shopId !== null && scope.shopIds.includes(line.shopId)))
              && (!currency || normalizedCurrency(line.currency) === currency)
            ))
            .map((line) => ({
              accountCode: line.account.code,
              accountClass: getAccountClass(line.account.code),
              accountName: line.account.name,
              bucket: AR_AP_ACCOUNT_CODES.includes(line.account.code as ArApAccountCode)
                ? accountBucket[line.account.code as ArApAccountCode]
                : 'other_journal_line',
              direction: line.direction,
              amount: Number(line.amount.toString()),
              currency: normalizedCurrency(line.currency),
              shopId: line.shopId,
              memo: line.memo,
              payableClassification: ['2000', '2100'].includes(line.account.code)
                ? getPayableClassification(line)
                : undefined,
            })),
        };
      })
      .sort((left, right) => right.entryDate.localeCompare(left.entryDate));
  }
}