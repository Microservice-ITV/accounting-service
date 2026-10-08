ALTER TABLE "Expense"
    DROP CONSTRAINT "Expense_deliveryProviderId_fkey";

ALTER TABLE "Expense"
    ADD CONSTRAINT "Expense_deliveryProviderId_fkey"
    FOREIGN KEY ("deliveryProviderId") REFERENCES "DeliveryProvider"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
