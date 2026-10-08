CREATE TABLE "DeliveryProvider" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryProvider_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "DeliveryFee" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "DeliveryFee_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DeliveryProvider_code_key" ON "DeliveryProvider"("code");
CREATE INDEX "DeliveryFee_providerId_isActive_effectiveFrom_effectiveUntil_idx"
    ON "DeliveryFee"("providerId", "isActive", "effectiveFrom", "effectiveUntil");
ALTER TABLE "DeliveryFee"
    ADD CONSTRAINT "DeliveryFee_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "DeliveryProvider"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD COLUMN "deliveryProviderId" TEXT;
CREATE INDEX "Expense_deliveryProviderId_idx" ON "Expense"("deliveryProviderId");
ALTER TABLE "Expense"
    ADD CONSTRAINT "Expense_deliveryProviderId_fkey"
    FOREIGN KEY ("deliveryProviderId") REFERENCES "DeliveryProvider"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
