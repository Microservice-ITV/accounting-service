-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE');

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- CreateEnum
CREATE TYPE "Direction" AS ENUM ('DEBIT', 'CREDIT');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('DRAFT', 'POSTED', 'REVERSED');

-- CreateEnum
CREATE TYPE "ExpenseStatus" AS ENUM ('DRAFT', 'SUBMITTED', 'PENDING_APPROVAL', 'RETURNED', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalApproverType" AS ENUM ('DIRECT_MANAGER', 'MANAGER_CHAIN', 'ROLE', 'POSITION', 'SPECIFIC_USER');

-- CreateEnum
CREATE TYPE "ApprovalStatus" AS ENUM ('WAITING', 'PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ApprovalActionType" AS ENUM ('SUBMITTED', 'APPROVED', 'REJECTED', 'RETURNED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AccountType" NOT NULL,
    "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
    "description" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "expenseNo" TEXT NOT NULL,
    "shopId" TEXT,
    "sellerUserId" TEXT,
    "expenseTypeId" TEXT NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MMK',
    "description" TEXT,
    "expenseDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "ExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalPolicy" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "expenseTypeId" TEXT,
    "minAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "maxAmount" DECIMAL(65,30),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalPolicyStep" (
    "id" TEXT NOT NULL,
    "approvalPolicyId" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "approverType" "ApprovalApproverType" NOT NULL,
    "approverReference" TEXT NOT NULL,
    "isRequired" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalPolicyStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApprovalPolicyCondition" (
    "id" TEXT NOT NULL,
    "approvalPolicyId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "operator" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovalPolicyCondition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseApproval" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "stepNo" INTEGER NOT NULL,
    "approverUserId" TEXT,
    "status" "ApprovalStatus" NOT NULL DEFAULT 'WAITING',
    "action" "ApprovalActionType",
    "comment" TEXT,
    "approvedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExpenseApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseApprovalAction" (
    "id" TEXT NOT NULL,
    "expenseApprovalId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" "ApprovalActionType" NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseApprovalAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSettlement" (
    "id" TEXT NOT NULL,
    "paymentReference" TEXT NOT NULL,
    "orderId" TEXT,
    "checkoutId" TEXT,
    "eventId" TEXT,
    "journalEntryId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "totalAmount" DECIMAL(65,30) NOT NULL,
    "sellerPayableAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentSettlementLine" (
    "id" TEXT NOT NULL,
    "settlementId" TEXT NOT NULL,
    "shopId" TEXT,
    "sellerId" TEXT,
    "grossAmount" DECIMAL(65,30) NOT NULL,
    "payableAmount" DECIMAL(65,30) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentSettlementLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "JournalEntry" (
    "id" TEXT NOT NULL,
    "referenceType" TEXT NOT NULL,
    "referenceId" TEXT NOT NULL,
    "eventId" TEXT,
    "narration" TEXT,
    "entryDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "EntryStatus" NOT NULL DEFAULT 'POSTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "JournalEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EntryLine" (
    "id" TEXT NOT NULL,
    "journalEntryId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "direction" "Direction" NOT NULL,
    "amount" DECIMAL(65,30) NOT NULL,
    "memo" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EntryLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Account_code_key" ON "Account"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_code_key" ON "ExpenseCategory"("code");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_name_key" ON "ExpenseCategory"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_expenseNo_key" ON "Expense"("expenseNo");

-- CreateIndex
CREATE INDEX "Expense_shopId_status_idx" ON "Expense"("shopId", "status");

-- CreateIndex
CREATE INDEX "Expense_sellerUserId_status_idx" ON "Expense"("sellerUserId", "status");

-- CreateIndex
CREATE INDEX "Expense_status_expenseDate_idx" ON "Expense"("status", "expenseDate");

-- CreateIndex
CREATE INDEX "ApprovalPolicy_expenseTypeId_isActive_idx" ON "ApprovalPolicy"("expenseTypeId", "isActive");

-- CreateIndex
CREATE INDEX "ApprovalPolicyStep_approvalPolicyId_stepNo_idx" ON "ApprovalPolicyStep"("approvalPolicyId", "stepNo");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovalPolicyStep_approvalPolicyId_stepNo_key" ON "ApprovalPolicyStep"("approvalPolicyId", "stepNo");

-- CreateIndex
CREATE INDEX "ApprovalPolicyCondition_approvalPolicyId_field_idx" ON "ApprovalPolicyCondition"("approvalPolicyId", "field");

-- CreateIndex
CREATE INDEX "ExpenseApproval_expenseId_status_stepNo_idx" ON "ExpenseApproval"("expenseId", "status", "stepNo");

-- CreateIndex
CREATE INDEX "ExpenseApproval_approverUserId_status_idx" ON "ExpenseApproval"("approverUserId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseApproval_expenseId_stepNo_key" ON "ExpenseApproval"("expenseId", "stepNo");

-- CreateIndex
CREATE INDEX "ExpenseApprovalAction_expenseApprovalId_createdAt_idx" ON "ExpenseApprovalAction"("expenseApprovalId", "createdAt");

-- CreateIndex
CREATE INDEX "ExpenseApprovalAction_userId_createdAt_idx" ON "ExpenseApprovalAction"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSettlement_paymentReference_key" ON "PaymentSettlement"("paymentReference");

-- CreateIndex
CREATE UNIQUE INDEX "PaymentSettlement_eventId_key" ON "PaymentSettlement"("eventId");

-- CreateIndex
CREATE INDEX "PaymentSettlement_orderId_idx" ON "PaymentSettlement"("orderId");

-- CreateIndex
CREATE INDEX "PaymentSettlement_checkoutId_idx" ON "PaymentSettlement"("checkoutId");

-- CreateIndex
CREATE INDEX "PaymentSettlement_journalEntryId_idx" ON "PaymentSettlement"("journalEntryId");

-- CreateIndex
CREATE INDEX "PaymentSettlementLine_settlementId_shopId_idx" ON "PaymentSettlementLine"("settlementId", "shopId");

-- CreateIndex
CREATE INDEX "PaymentSettlementLine_shopId_idx" ON "PaymentSettlementLine"("shopId");

-- CreateIndex
CREATE INDEX "PaymentSettlementLine_sellerId_idx" ON "PaymentSettlementLine"("sellerId");

-- CreateIndex
CREATE UNIQUE INDEX "JournalEntry_eventId_key" ON "JournalEntry"("eventId");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_expenseTypeId_fkey" FOREIGN KEY ("expenseTypeId") REFERENCES "ExpenseCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalPolicy" ADD CONSTRAINT "ApprovalPolicy_expenseTypeId_fkey" FOREIGN KEY ("expenseTypeId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalPolicyStep" ADD CONSTRAINT "ApprovalPolicyStep_approvalPolicyId_fkey" FOREIGN KEY ("approvalPolicyId") REFERENCES "ApprovalPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovalPolicyCondition" ADD CONSTRAINT "ApprovalPolicyCondition_approvalPolicyId_fkey" FOREIGN KEY ("approvalPolicyId") REFERENCES "ApprovalPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseApproval" ADD CONSTRAINT "ExpenseApproval_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseApprovalAction" ADD CONSTRAINT "ExpenseApprovalAction_expenseApprovalId_fkey" FOREIGN KEY ("expenseApprovalId") REFERENCES "ExpenseApproval"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSettlement" ADD CONSTRAINT "PaymentSettlement_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentSettlementLine" ADD CONSTRAINT "PaymentSettlementLine_settlementId_fkey" FOREIGN KEY ("settlementId") REFERENCES "PaymentSettlement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryLine" ADD CONSTRAINT "EntryLine_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EntryLine" ADD CONSTRAINT "EntryLine_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

