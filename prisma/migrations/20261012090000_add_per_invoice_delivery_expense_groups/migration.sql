ALTER TYPE "DeliveryChargingBasis" RENAME VALUE 'PER_DAY' TO 'PER_INVOICE';

ALTER TABLE "Expense"
ADD COLUMN "deliveryExpenseGroupId" TEXT;

CREATE UNIQUE INDEX "expenses_delivery_group_shop_company_key"
ON "Expense"("deliveryExpenseGroupId", "shopId", "deliveryCompanyId");

CREATE TABLE "delivery_expense_orders" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delivery_expense_orders_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "delivery_expense_orders_expenseId_orderId_key"
ON "delivery_expense_orders"("expenseId", "orderId");

CREATE INDEX "delivery_expense_orders_orderId_idx"
ON "delivery_expense_orders"("orderId");

ALTER TABLE "delivery_expense_orders"
ADD CONSTRAINT "delivery_expense_orders_expenseId_fkey"
FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;