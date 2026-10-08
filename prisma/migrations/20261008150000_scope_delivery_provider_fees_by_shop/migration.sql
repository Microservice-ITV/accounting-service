-- Keep historical provider-only fee rules intact; new configurations are
-- written with both shop and Delivery Company identity.
ALTER TABLE "DeliveryProviderFee"
    ADD COLUMN "shopId" TEXT,
    ADD COLUMN "deliveryCompanyId" TEXT;

CREATE INDEX "delivery_provider_fee_shop_company_effective_idx"
    ON "DeliveryProviderFee"("shopId", "deliveryCompanyId", "active", "effectiveFrom", "effectiveTo");

ALTER TABLE "Expense"
    ADD COLUMN "deliveryCompanyId" TEXT;

CREATE INDEX "Expense_deliveryCompanyId_idx"
    ON "Expense"("deliveryCompanyId");
