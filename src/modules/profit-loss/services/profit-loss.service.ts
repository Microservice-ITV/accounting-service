import type {
  AuthenticatedReportContext,
  BreakdownPoint,
  CurrencyBucket,
  ProfitLossQuery,
  ProfitLossQueryData,
  ProfitLossResponse,
  ReportScope,
  ScopedProfitLossQuery,
} from '../profit-loss.types.js';
import type { IProfitLossRepository } from '../interfaces/profit-loss.repository.interface.js';
import type { IProfitLossService } from '../interfaces/profit-loss.service.interface.js';

const PLATFORM_ROLES = new Set([
  'platform_super_admin',
  'super_admin',
  'platform_finance',
  'platform_director',
  'platform_cfo',
  'cfo',
]);

const MISSING_COMPONENTS = ['refunds', 'tax', 'cogs', 'paymentFees', 'commission', 'shipping'];

const normalizeShopId = (value?: string | null) => String(value ?? '').trim();
const numberOf = (value: number | string | { toString(): string }) => Number(value.toString());
const roundMoney = (value: number) => Number(value.toFixed(2));
const toDate = (value: Date | string) => value instanceof Date ? value : new Date(value);

export function resolveSellerShopScope(context?: AuthenticatedReportContext | null): ReportScope {
  if (!context) {
    throw new Error('Unauthenticated');
  }

  const role = normalizeShopId(context.role).toLowerCase();
  if (PLATFORM_ROLES.has(role)) return { shopIds: null };

  const shopIds = new Set(
    Array.from(context.authorizedShopIds ?? [])
      .map((shopId) => normalizeShopId(shopId))
      .filter(Boolean),
  );
  const activeShopId = normalizeShopId(context.activeShopId);
  if (activeShopId) shopIds.add(activeShopId);

  if (shopIds.size === 0) {
    throw new Error('Seller must be assigned to an authorized shop');
  }
  return { shopIds: [...shopIds] };
}

export function resolveRequestedShopScope(scope: ReportScope, requestedShopId?: string | null): ReportScope {
  const shopId = normalizeShopId(requestedShopId);
  if (!shopId) return scope;
  if (scope.shopIds && !scope.shopIds.includes(shopId)) {
    throw new Error('Forbidden: shop is not assigned to this user');
  }
  return { shopIds: [shopId] };
}

const periodFor = (value: Date | string, groupBy: 'day' | 'month') => {
  const date = toDate(value);
  return groupBy === 'month' ? date.toISOString().slice(0, 7) : date.toISOString().slice(0, 10);
};

const createPoint = (period: string): BreakdownPoint => ({
  period,
  grossSales: 0,
  discounts: 0,
  refunds: null,
  cogs: null,
  paymentFees: null,
  shipping: null,
  platformFundedItemDiscounts: 0,
  sellerFundedShippingDiscounts: 0,
  platformFundedShippingDiscounts: 0,
  actualRevenue: 0,
  operatingExpenses: 0,
  currentProfitOrLoss: 0,
});

export function buildProfitLossResponse(query: ScopedProfitLossQuery, data: ProfitLossQueryData): ProfitLossResponse {
  const buckets = new Map<string, CurrencyBucket>();
  const ensureBucket = (currencyValue: string, period?: string) => {
    const currency = currencyValue.trim() || 'UNKNOWN';
    let bucket = buckets.get(currency);
    if (!bucket) {
      bucket = {
        grossSales: 0,
        sellerItemDiscounts: 0,
        platformItemDiscounts: 0,
        sellerShippingDiscounts: 0,
        platformShippingDiscounts: 0,
        actualRevenue: 0,
        operatingExpenses: 0,
        hasIncompleteDiscountAllocations: false,
        periods: new Map(),
      };
      buckets.set(currency, bucket);
    }
    if (period && !bucket.periods.has(period)) bucket.periods.set(period, createPoint(period));
    return { currency, bucket, point: period ? bucket.periods.get(period) : undefined };
  };

  const shopIsInScope = (shopId: string | null) =>
    Boolean(shopId) && (!query.scope.shopIds || query.scope.shopIds.includes(shopId!));

  const merchandiseIncomeByOrderAndShop = new Map<string, number>();
  for (const sale of data.salesProjections) {
    const sellerItemDiscounts = sale.discounts
      .filter((discount) => discount.discountType === 'ITEM' && discount.fundedBy === 'SELLER')
      .reduce((sum, discount) => sum + numberOf(discount.amount), 0);
    const key = `${sale.orderId}\u0000${sale.shopId}`;
    merchandiseIncomeByOrderAndShop.set(
      key,
      Math.max(0, numberOf(sale.grossItemSales) - sellerItemDiscounts),
    );
  }

  const paymentOrderByReference = new Map(
    data.paymentLines
      .filter((line) => Boolean(line.settlement.orderId))
      .map((line) => [line.settlement.paymentReference, line.settlement.orderId!]),
  );

  const reportEntries = data.entries.map((line) => {
    if (
      line.journalEntry.referenceType !== 'PAYMENT'
      || line.account.type !== 'INCOME'
      || line.direction !== 'CREDIT'
    ) {
      return line;
    }

    const memo = String(line.memo ?? '');
    const shopMatch = memo.match(/(?:^|[\s,(])shop(?:_id)?=([^,\s)]+)/i);
    const memoOrderMatch = memo.match(/(?:^|[\s,(])order(?:_id)?=([^,\s)]+)/i);
    const orderId = memoOrderMatch?.[1] ?? paymentOrderByReference.get(line.journalEntry.referenceId);
    if (!shopMatch || !orderId) return line;

    const merchandiseIncome = merchandiseIncomeByOrderAndShop.get(`${orderId}\u0000${shopMatch[1]}`);
    return merchandiseIncome === undefined ? line : { ...line, amount: merchandiseIncome };
  });

  const incomeByPaymentAndShop = new Map<string, number>();
  for (const line of reportEntries) {
    if (
      line.journalEntry.referenceType !== 'PAYMENT'
      || line.account.type !== 'INCOME'
      || line.direction !== 'CREDIT'
    ) {
      continue;
    }
    const shopMatch = String(line.memo ?? '').match(/(?:^|[\s,(])shop(?:_id)?=([^,\s)]+)/i);
    if (!shopMatch) continue;
    const key = `${line.journalEntry.referenceId}\u0000${shopMatch[1]}`;
    incomeByPaymentAndShop.set(
      key,
      (incomeByPaymentAndShop.get(key) ?? 0) + numberOf(line.amount),
    );
  }

  const paymentsByReferenceAndShop = new Map<string, {
    currency: string;
    createdAt: Date | string;
  }>();
  for (const line of data.paymentLines) {
    if (!shopIsInScope(line.shopId)) continue;
    const key = `${line.settlement.paymentReference}\u0000${line.shopId}`;
    if (!paymentsByReferenceAndShop.has(key)) {
      paymentsByReferenceAndShop.set(key, {
        currency: line.currency,
        createdAt: line.settlement.createdAt,
      });
    }
  }

  for (const sale of data.salesProjections) {
    if (!shopIsInScope(sale.shopId)) continue;
    const period = periodFor(sale.orderPaidAt, query.groupBy);
    const { bucket, point } = ensureBucket(sale.currency, period);
    const gross = numberOf(sale.grossItemSales);
    bucket.grossSales += gross;
    point!.grossSales += gross;
    bucket.hasIncompleteDiscountAllocations ||= !sale.discountAllocationsComplete;

    for (const discount of sale.discounts) {
      const amount = numberOf(discount.amount);
      if (discount.discountType === 'ITEM' && discount.fundedBy === 'SELLER') {
        bucket.sellerItemDiscounts += amount;
        point!.discounts = (point!.discounts ?? 0) + amount;
      } else if (discount.discountType === 'ITEM' && discount.fundedBy === 'PLATFORM') {
        bucket.platformItemDiscounts += amount;
        point!.platformFundedItemDiscounts = (point!.platformFundedItemDiscounts ?? 0) + amount;
      } else if (discount.discountType === 'SHIPPING' && discount.fundedBy === 'SELLER') {
        bucket.sellerShippingDiscounts += amount;
        point!.sellerFundedShippingDiscounts = (point!.sellerFundedShippingDiscounts ?? 0) + amount;
      } else if (discount.discountType === 'SHIPPING' && discount.fundedBy === 'PLATFORM') {
        bucket.platformShippingDiscounts += amount;
        point!.platformFundedShippingDiscounts = (point!.platformFundedShippingDiscounts ?? 0) + amount;
      }
    }
  }

  for (const [key, payment] of paymentsByReferenceAndShop) {
    const period = periodFor(payment.createdAt, query.groupBy);
    const { bucket, point } = ensureBucket(payment.currency, period);
    const amount = incomeByPaymentAndShop.get(key) ?? 0;
    bucket.actualRevenue += amount;
    point!.actualRevenue += amount;
  }

  for (const expense of data.expenses) {
    if (expense.scope !== 'SHOP' || expense.status !== 'APPROVED' || !shopIsInScope(expense.shopId)) continue;
    const expenseDate = toDate(expense.expenseDate);
    if (query.from && expenseDate < query.from) continue;
    if (query.to && expenseDate >= query.to) continue;
    const period = periodFor(expense.expenseDate, query.groupBy);
    const { bucket, point } = ensureBucket(expense.currency, period);
    const amount = numberOf(expense.amount);
    bucket.operatingExpenses += amount;
    point!.operatingExpenses += amount;
  }

  const reports = [...buckets.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, bucket]) => {
    const discounts = bucket.hasIncompleteDiscountAllocations ? null : roundMoney(bucket.sellerItemDiscounts);
    const netSales = discounts === null ? null : roundMoney(bucket.grossSales - bucket.sellerItemDiscounts);
    const missingComponents = [
      ...MISSING_COMPONENTS,
      ...(bucket.hasIncompleteDiscountAllocations ? ['discountAllocations'] : []),
    ];

    const breakdown = [...bucket.periods.values()].sort((left, right) => left.period.localeCompare(right.period)).map((point) => {
      const pointDiscounts = bucket.hasIncompleteDiscountAllocations ? null : point.discounts;
      return {
        ...point,
        grossSales: roundMoney(point.grossSales),
        discounts: pointDiscounts === null ? null : roundMoney(pointDiscounts ?? 0),
        platformFundedItemDiscounts: bucket.hasIncompleteDiscountAllocations
          ? null
          : roundMoney(point.platformFundedItemDiscounts ?? 0),
        sellerFundedShippingDiscounts: bucket.hasIncompleteDiscountAllocations
          ? null
          : roundMoney(point.sellerFundedShippingDiscounts ?? 0),
        platformFundedShippingDiscounts: bucket.hasIncompleteDiscountAllocations
          ? null
          : roundMoney(point.platformFundedShippingDiscounts ?? 0),
        actualRevenue: roundMoney(point.actualRevenue),
        operatingExpenses: roundMoney(point.operatingExpenses),
        currentProfitOrLoss: roundMoney(point.actualRevenue - point.operatingExpenses),
      };
    });

    return {
      currency,
      complete: false as const,
      missingComponents,
      revenue: {
        grossSales: roundMoney(bucket.grossSales),
        discounts,
        netSales,
        refunds: null,
        tax: null,
        platformFundedItemDiscounts: bucket.hasIncompleteDiscountAllocations
          ? null
          : roundMoney(bucket.platformItemDiscounts),
        sellerFundedShippingDiscounts: bucket.hasIncompleteDiscountAllocations
          ? null
          : roundMoney(bucket.sellerShippingDiscounts),
        platformFundedShippingDiscounts: bucket.hasIncompleteDiscountAllocations
          ? null
          : roundMoney(bucket.platformShippingDiscounts),
      },
      actualRevenue: roundMoney(bucket.actualRevenue),
      refunds: null,
      tax: null,
      expenses: {
        operatingExpenses: roundMoney(bucket.operatingExpenses),
        cogs: null,
        paymentFees: null,
        commission: null,
        shipping: null,
      },
      profit: {
        currentProfitOrLoss: roundMoney(bucket.actualRevenue - bucket.operatingExpenses),
        grossProfit: null,
        netProfit: null,
        ledgerProfit: {
          totalIncome: roundMoney(bucket.actualRevenue),
          totalExpense: roundMoney(bucket.operatingExpenses),
          netProfit: roundMoney(bucket.actualRevenue - bucket.operatingExpenses),
          label: 'Current partial profit/loss; not complete ecommerce profit',
        },
      },
      commissionStatus: 'unresolved: order-service computes 3%; wallet settlement defaults to 5%',
      breakdown,
    };
  });

  const canAggregateTopLevelTotals = reports.length <= 1;
  const totalIncome = reports.reduce((sum, report) => sum + report.actualRevenue, 0);
  const totalExpense = reports.reduce((sum, report) => sum + report.expenses.operatingExpenses, 0);

  return {
    totalIncome: canAggregateTopLevelTotals ? roundMoney(totalIncome) : null,
    totalExpense: canAggregateTopLevelTotals ? roundMoney(totalExpense) : null,
    netProfit: canAggregateTopLevelTotals ? roundMoney(totalIncome - totalExpense) : null,
    entries: reportEntries,
    complete: false,
    groupBy: query.groupBy,
    currency: reports.length === 1 ? reports[0].currency : null,
    refunds: null,
    tax: null,
    cogs: null,
    paymentFees: null,
    commission: null,
    missingComponents: [...new Set([
      ...MISSING_COMPONENTS,
      ...reports.flatMap((report) => report.missingComponents.includes('discountAllocations') ? ['discountAllocations'] : []),
    ])],
    commissionStatus: 'unresolved: order-service computes 3%; wallet settlement defaults to 5%',
    reports,
  };
}

export class ProfitLossService implements IProfitLossService {
  constructor(private readonly profitLossRepository: IProfitLossRepository) {}

  async getProfitLoss(
    query: ProfitLossQuery,
    context: AuthenticatedReportContext,
  ): Promise<ProfitLossResponse> {
    const scope = resolveRequestedShopScope(
      resolveSellerShopScope(context),
      query.requestedShopId,
    );
    const scopedQuery: ScopedProfitLossQuery = { ...query, scope };
    const data = await this.profitLossRepository.getProfitLossData(scopedQuery);
    return buildProfitLossResponse(scopedQuery, {
      ...data,
      entries: this.filterLedgerEntries(data, scopedQuery, context),
    });
  }

  private filterLedgerEntries(
    data: ProfitLossQueryData,
    query: ScopedProfitLossQuery,
    context: AuthenticatedReportContext,
  ): ProfitLossQueryData['entries'] {
    const authorizedShopIds = new Set(
      Array.from(context.authorizedShopIds ?? [])
        .map((shopId) => String(shopId).trim())
        .filter(Boolean),
    );
    if (context.activeShopId) authorizedShopIds.add(String(context.activeShopId).trim());
    const allScope = query.scope.shopIds === null;
    const expenseShopByReference = new Map(
      data.expenses
        .filter((expense) => Boolean(expense.expenseNo))
        .map((expense) => [expense.expenseNo!, expense.shopId]),
    );

    return data.entries.filter((line) => {
      const entry = line.journalEntry;
      if (entry.referenceType === 'EXPENSE') {
        const shopId = expenseShopByReference.get(entry.referenceId);
        return Boolean(shopId) && (allScope || authorizedShopIds.has(String(shopId)));
      }
      if (entry.referenceType !== 'PAYMENT' || line.account.type !== 'INCOME' || line.direction !== 'CREDIT') {
        return false;
      }
      const memo = String(line.memo ?? '');
      const shopMatch = memo.match(/(?:^|[\s,(])shop(?:_id)?=([^,\s)]+)/i);
      if (!shopMatch) return false;
      const shopId = shopMatch[1];
      return allScope || authorizedShopIds.has(shopId);
    });
  }
}
