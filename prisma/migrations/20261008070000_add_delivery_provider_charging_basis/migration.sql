CREATE TYPE "DeliveryChargingBasis" AS ENUM ('PER_ORDER', 'PER_DAY');

ALTER TABLE "DeliveryFee" RENAME TO "DeliveryProviderFee";
ALTER TABLE "DeliveryProviderFee" RENAME COLUMN "isActive" TO "active";
ALTER TABLE "DeliveryProviderFee" RENAME COLUMN "effectiveUntil" TO "effectiveTo";
ALTER TABLE "DeliveryProviderFee"
    ADD COLUMN "chargingBasis" "DeliveryChargingBasis" NOT NULL DEFAULT 'PER_ORDER';

ALTER TABLE "DeliveryProviderFee"
    RENAME CONSTRAINT "DeliveryFee_pkey" TO "DeliveryProviderFee_pkey";
ALTER TABLE "DeliveryProviderFee"
    RENAME CONSTRAINT "DeliveryFee_providerId_fkey" TO "DeliveryProviderFee_providerId_fkey";
ALTER INDEX "DeliveryFee_providerId_isActive_effectiveFrom_effectiveUntil_idx"
    RENAME TO "delivery_provider_fee_effective_idx";
