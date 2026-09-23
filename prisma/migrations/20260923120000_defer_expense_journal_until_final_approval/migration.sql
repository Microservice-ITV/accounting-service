ALTER TABLE "Expense" ADD COLUMN "expenseAccountCode" TEXT NOT NULL DEFAULT '5000';
ALTER TABLE "Expense" ADD COLUMN "fundingAccountCode" TEXT NOT NULL DEFAULT '1000';

CREATE UNIQUE INDEX "JournalEntry_referenceType_referenceId_key"
ON "JournalEntry"("referenceType", "referenceId");