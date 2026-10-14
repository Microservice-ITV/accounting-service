BEGIN;

CREATE TEMPORARY TABLE "delivery_invoice_expense_reference_map" ON COMMIT DROP AS
SELECT
    "id",
    "expenseNo" AS "oldExpenseNo",
    'DELI-INVOICE-' || TO_CHAR("expenseDate", 'YYYYMMDD') || '-'
      || LPAD(ROW_NUMBER() OVER (
          PARTITION BY TO_CHAR("expenseDate", 'YYYYMMDD')
          ORDER BY "createdAt", "id"
      )::TEXT, 4, '0') AS "newExpenseNo"
FROM "Expense"
WHERE "expenseNo" LIKE 'DELI-INVOICE-%'
  AND "deliveryExpenseGroupId" IS NOT NULL;

UPDATE "JournalEntry" AS journal
SET "referenceId" = reference_map."newExpenseNo"
FROM "delivery_invoice_expense_reference_map" AS reference_map
WHERE journal."referenceType" = 'EXPENSE'
  AND journal."referenceId" = reference_map."oldExpenseNo";

UPDATE "Expense" AS expense
SET "expenseNo" = reference_map."newExpenseNo"
FROM "delivery_invoice_expense_reference_map" AS reference_map
WHERE expense."id" = reference_map."id";

COMMIT;
