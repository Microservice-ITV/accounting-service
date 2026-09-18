ALTER TABLE "Account"
  ADD COLUMN "description" TEXT,
  ADD COLUMN "parentId" TEXT;

CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Account"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;