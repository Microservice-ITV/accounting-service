CREATE TYPE "ExpenseScope" AS ENUM ('SHOP', 'PLATFORM');

ALTER TABLE "Expense"
  ADD COLUMN "scope" "ExpenseScope" NOT NULL DEFAULT 'SHOP',
  ADD COLUMN "createdByUserId" TEXT;

ALTER TABLE "ApprovalPolicy"
  ADD COLUMN "scope" "ExpenseScope" NOT NULL DEFAULT 'SHOP',
  ADD COLUMN "shopId" TEXT,
  ADD COLUMN "approverUserId" TEXT;

CREATE INDEX "Expense_scope_status_idx" ON "Expense"("scope", "status");
CREATE INDEX "Expense_createdByUserId_status_idx" ON "Expense"("createdByUserId", "status");
CREATE INDEX "ApprovalPolicy_scope_shopId_isActive_minAmount_idx"
  ON "ApprovalPolicy"("scope", "shopId", "isActive", "minAmount");