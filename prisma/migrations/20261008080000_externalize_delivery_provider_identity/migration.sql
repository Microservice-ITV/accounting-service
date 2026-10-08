-- Preserve Accounting's historical provider records for administrator-led
-- reconciliation while making fee provider IDs externally owned.
ALTER TABLE "DeliveryProviderFee"
    DROP CONSTRAINT "DeliveryProviderFee_providerId_fkey";

ALTER TABLE "Expense"
    DROP CONSTRAINT "Expense_deliveryProviderId_fkey";

ALTER TABLE "DeliveryProvider" RENAME TO "LegacyDeliveryProviderArchive";
