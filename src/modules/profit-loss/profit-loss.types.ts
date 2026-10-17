export type AuthenticatedReportContext = {
  role?: string | null;
  activeShopId?: string | null;
  authorizedShopIds?: Iterable<string> | null;
};

export type ReportScope = {
  shopIds: string[] | null;
};

export type ProfitLossQuery = {
  from?: Date;
  to?: Date;
  groupBy: 'day' | 'month';
  requestedShopId?: string;
};

export type ScopedProfitLossQuery = ProfitLossQuery & {
  scope: ReportScope;
};

type MoneyValue = number | string | { toString(): string };

export type SalesProjection = {
  orderId: string;
  shopId: string;
  currency: string;
  grossItemSales: MoneyValue;
  discountTotal: MoneyValue;
  shippingTotal: MoneyValue;
  paidAmount: MoneyValue;
  discountAllocationsComplete: boolean;
  orderPaidAt: Date | string;
  discounts: Array<{
    discountType: string;
    fundedBy: string;
    amount: MoneyValue;
  }>;
};

export type RecognizedPaymentLine = {
  shopId: string | null;
  currency: string;
  grossAmount: MoneyValue;
  settlement: { paymentReference: string; orderId: string | null; createdAt: Date | string };
};

export type ReportExpense = {
  expenseNo?: string;
  shopId: string | null;
  scope: string;
  status: string;
  currency: string;
  amount: MoneyValue;
  expenseDate: Date | string;
};

export type ProfitLossLedgerEntry = {
  direction: string;
  amount: MoneyValue;
  memo: string | null;
  currency?: string | null;
  shopId?: string | null;
  journalEntry: {
    referenceType: string;
    referenceId: string;
    entryDate?: Date | string;
  };
  account: {
    type: string;
    code?: string;
  };
};

export type ProfitLossQueryData = {
  salesProjections: SalesProjection[];
  paymentLines: RecognizedPaymentLine[];
  expenses: ReportExpense[];
  entries: ProfitLossLedgerEntry[];
};

export type BreakdownPoint = {
  period: string;
  grossSales: number;
  discounts: number | null;
  refunds: null;
  cogs: null;
  paymentFees: null;
  shipping: null;
  platformFundedItemDiscounts: number | null;
  sellerFundedShippingDiscounts: number | null;
  platformFundedShippingDiscounts: number | null;
  actualRevenue: number;
  operatingExpenses: number;
  currentProfitOrLoss: number;
};

export type CurrencyBucket = {
  grossSales: number;
  sellerItemDiscounts: number;
  platformItemDiscounts: number;
  sellerShippingDiscounts: number;
  platformShippingDiscounts: number;
  actualRevenue: number;
  operatingExpenses: number;
  hasIncompleteDiscountAllocations: boolean;
  periods: Map<string, BreakdownPoint>;
};

export type ProfitLossCurrencyReport = {
  currency: string;
  complete: false;
  missingComponents: string[];
  revenue: {
    grossSales: number;
    discounts: number | null;
    netSales: number | null;
    refunds: null;
    tax: null;
    platformFundedItemDiscounts: number | null;
    sellerFundedShippingDiscounts: number | null;
    platformFundedShippingDiscounts: number | null;
  };
  actualRevenue: number;
  refunds: null;
  tax: null;
  expenses: {
    operatingExpenses: number;
    cogs: null;
    paymentFees: null;
    commission: null;
    shipping: null;
  };
  profit: {
    currentProfitOrLoss: number;
    grossProfit: null;
    netProfit: null;
    ledgerProfit: {
      totalIncome: number;
      totalExpense: number;
      netProfit: number;
      label: string;
    };
  };
  commissionStatus: string;
  breakdown: BreakdownPoint[];
};

export type ProfitLossResponse = {
  totalIncome: number | null;
  entries: ProfitLossLedgerEntry[];
  totalExpense: number | null;
  netProfit: number | null;
  complete: false;
  groupBy: 'day' | 'month';
  currency: string | null;
  refunds: null;
  tax: null;
  cogs: null;
  paymentFees: null;
  commission: null;
  missingComponents: string[];
  commissionStatus: string;
  reports: ProfitLossCurrencyReport[];
};
