-- Create one domain-scoped status catalog shared by accounting entities.
CREATE TABLE "AccountingStatus" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AccountingStatus_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountingStatus_domain_code_key" ON "AccountingStatus"("domain", "code");
CREATE INDEX "AccountingStatus_domain_isActive_idx" ON "AccountingStatus"("domain", "isActive");

INSERT INTO "AccountingStatus" ("id", "domain", "code", "label", "updatedAt") VALUES
  ('status-account-active', 'ACCOUNT', 'ACTIVE', 'Active', CURRENT_TIMESTAMP),
  ('status-account-inactive', 'ACCOUNT', 'INACTIVE', 'Inactive', CURRENT_TIMESTAMP),
  ('status-category-active', 'EXPENSE_CATEGORY', 'ACTIVE', 'Active', CURRENT_TIMESTAMP),
  ('status-category-inactive', 'EXPENSE_CATEGORY', 'INACTIVE', 'Inactive', CURRENT_TIMESTAMP),
  ('status-expense-draft', 'EXPENSE', 'DRAFT', 'Draft', CURRENT_TIMESTAMP),
  ('status-expense-submitted', 'EXPENSE', 'SUBMITTED', 'Submitted', CURRENT_TIMESTAMP),
  ('status-expense-pending-approval', 'EXPENSE', 'PENDING_APPROVAL', 'Pending approval', CURRENT_TIMESTAMP),
  ('status-expense-returned', 'EXPENSE', 'RETURNED', 'Returned', CURRENT_TIMESTAMP),
  ('status-expense-approved', 'EXPENSE', 'APPROVED', 'Approved', CURRENT_TIMESTAMP),
  ('status-expense-rejected', 'EXPENSE', 'REJECTED', 'Rejected', CURRENT_TIMESTAMP),
  ('status-expense-cancelled', 'EXPENSE', 'CANCELLED', 'Cancelled', CURRENT_TIMESTAMP),
  ('status-approval-waiting', 'APPROVAL', 'WAITING', 'Waiting', CURRENT_TIMESTAMP),
  ('status-approval-pending', 'APPROVAL', 'PENDING', 'Pending', CURRENT_TIMESTAMP),
  ('status-approval-approved', 'APPROVAL', 'APPROVED', 'Approved', CURRENT_TIMESTAMP),
  ('status-approval-rejected', 'APPROVAL', 'REJECTED', 'Rejected', CURRENT_TIMESTAMP),
  ('status-approval-cancelled', 'APPROVAL', 'CANCELLED', 'Cancelled', CURRENT_TIMESTAMP),
  ('status-entry-draft', 'ENTRY', 'DRAFT', 'Draft', CURRENT_TIMESTAMP),
  ('status-entry-posted', 'ENTRY', 'POSTED', 'Posted', CURRENT_TIMESTAMP),
  ('status-entry-reversed', 'ENTRY', 'REVERSED', 'Reversed', CURRENT_TIMESTAMP),
  ('status-settlement-posted', 'SETTLEMENT', 'POSTED', 'Posted', CURRENT_TIMESTAMP);

-- Convert enum-backed columns to required status codes while preserving existing values.
ALTER TABLE "Account" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Account" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "Account" ALTER COLUMN "status" SET DEFAULT 'ACTIVE';
ALTER TABLE "Account" ADD COLUMN "statusDomain" TEXT NOT NULL DEFAULT 'ACCOUNT';

ALTER TABLE "Expense" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "Expense" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "Expense" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
ALTER TABLE "Expense" ADD COLUMN "statusDomain" TEXT NOT NULL DEFAULT 'EXPENSE';

ALTER TABLE "ExpenseApproval" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "ExpenseApproval" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "ExpenseApproval" ALTER COLUMN "status" SET DEFAULT 'WAITING';
ALTER TABLE "ExpenseApproval" ADD COLUMN "statusDomain" TEXT NOT NULL DEFAULT 'APPROVAL';

ALTER TABLE "JournalEntry" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "JournalEntry" ALTER COLUMN "status" TYPE TEXT USING "status"::text;
ALTER TABLE "JournalEntry" ALTER COLUMN "status" SET DEFAULT 'POSTED';
ALTER TABLE "JournalEntry" ADD COLUMN "statusDomain" TEXT NOT NULL DEFAULT 'ENTRY';

ALTER TABLE "ExpenseCategory" ADD COLUMN "statusDomain" TEXT NOT NULL DEFAULT 'EXPENSE_CATEGORY';
ALTER TABLE "PaymentSettlement" ADD COLUMN "statusDomain" TEXT NOT NULL DEFAULT 'SETTLEMENT';

-- Category status was historically free text; keep valid values required by the catalog.
UPDATE "ExpenseCategory"
SET "status" = 'INACTIVE'
WHERE "status" NOT IN ('ACTIVE', 'INACTIVE');

CREATE INDEX "Account_statusDomain_status_idx" ON "Account"("statusDomain", "status");
CREATE INDEX "ExpenseCategory_statusDomain_status_idx" ON "ExpenseCategory"("statusDomain", "status");
CREATE INDEX "Expense_statusDomain_status_idx" ON "Expense"("statusDomain", "status");
CREATE INDEX "ExpenseApproval_statusDomain_status_idx" ON "ExpenseApproval"("statusDomain", "status");
CREATE INDEX "PaymentSettlement_statusDomain_status_idx" ON "PaymentSettlement"("statusDomain", "status");
CREATE INDEX "JournalEntry_statusDomain_status_idx" ON "JournalEntry"("statusDomain", "status");

ALTER TABLE "Account" ADD CONSTRAINT "Account_statusDomain_status_fkey"
  FOREIGN KEY ("statusDomain", "status") REFERENCES "AccountingStatus"("domain", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseCategory" ADD CONSTRAINT "ExpenseCategory_statusDomain_status_fkey"
  FOREIGN KEY ("statusDomain", "status") REFERENCES "AccountingStatus"("domain", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_statusDomain_status_fkey"
  FOREIGN KEY ("statusDomain", "status") REFERENCES "AccountingStatus"("domain", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExpenseApproval" ADD CONSTRAINT "ExpenseApproval_statusDomain_status_fkey"
  FOREIGN KEY ("statusDomain", "status") REFERENCES "AccountingStatus"("domain", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PaymentSettlement" ADD CONSTRAINT "PaymentSettlement_statusDomain_status_fkey"
  FOREIGN KEY ("statusDomain", "status") REFERENCES "AccountingStatus"("domain", "code") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "JournalEntry" ADD CONSTRAINT "JournalEntry_statusDomain_status_fkey"
  FOREIGN KEY ("statusDomain", "status") REFERENCES "AccountingStatus"("domain", "code") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP TYPE "AccountStatus";
DROP TYPE "EntryStatus";
DROP TYPE "ExpenseStatus";
DROP TYPE "ApprovalStatus";
