-- Migrate ApprovalPolicy from configurable approver steps to manager depth.
ALTER TABLE "ApprovalPolicy" DROP CONSTRAINT IF EXISTS "ApprovalPolicy_expenseTypeId_fkey";
DROP INDEX IF EXISTS "ApprovalPolicy_expenseTypeId_isActive_idx";

ALTER TABLE "ApprovalPolicy"
  DROP COLUMN IF EXISTS "expenseTypeId",
  DROP COLUMN IF EXISTS "priority",
  ADD COLUMN IF NOT EXISTS "level" INTEGER NOT NULL DEFAULT 1;

DROP TABLE IF EXISTS "ApprovalPolicyStep";
DROP TYPE IF EXISTS "ApprovalApproverType";

CREATE INDEX IF NOT EXISTS "ApprovalPolicy_isActive_minAmount_idx"
  ON "ApprovalPolicy"("isActive", "minAmount");
