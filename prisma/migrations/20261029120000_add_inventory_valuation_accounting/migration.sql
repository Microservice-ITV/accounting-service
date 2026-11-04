CREATE TABLE "InventoryAccountMapping" (
    "id" TEXT NOT NULL,
    "mappingKey" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "approvedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryAccountMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryValuationMovement" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "movementId" TEXT NOT NULL,
    "movementType" TEXT NOT NULL,
    "sourceDocumentId" TEXT NOT NULL,
    "sourceDocumentType" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "variantId" TEXT NOT NULL,
    "quantity" DECIMAL(18,4) NOT NULL,
    "unitCostMmk" DECIMAL(18,2),
    "totalCostMmk" DECIMAL(18,2),
    "currency" TEXT NOT NULL,
    "onHandQty" DECIMAL(18,4) NOT NULL,
    "averageUnitCostMmk" DECIMAL(18,2),
    "inventoryValueMmk" DECIMAL(18,2),
    "valuationVersion" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "originalCurrency" TEXT,
    "originalAmount" DECIMAL(18,2),
    "appliedExchangeRate" DECIMAL(18,8),
    "rateDate" TEXT,
    "rateSource" TEXT,
    "status" TEXT NOT NULL DEFAULT 'BLOCKED',
    "blockReasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rawPayload" JSONB NOT NULL,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryValuationMovement_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InventoryValuationSnapshot" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "warehouseId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "sku" TEXT,
    "variantId" TEXT NOT NULL,
    "onHandQty" DECIMAL(18,4) NOT NULL,
    "averageUnitCostMmk" DECIMAL(18,2),
    "inventoryValueMmk" DECIMAL(18,2),
    "valuationVersion" INTEGER NOT NULL,
    "lastEventId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InventoryValuationSnapshot_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InventoryAccountMapping_mappingKey_key"
ON "InventoryAccountMapping"("mappingKey");
CREATE INDEX "InventoryAccountMapping_accountId_idx"
ON "InventoryAccountMapping"("accountId");
CREATE UNIQUE INDEX "InventoryValuationMovement_eventId_key"
ON "InventoryValuationMovement"("eventId");
CREATE INDEX "InventoryValuationMovement_shopId_occurredAt_idx"
ON "InventoryValuationMovement"("shopId", "occurredAt");
CREATE INDEX "InventoryValuationMovement_warehouseId_occurredAt_idx"
ON "InventoryValuationMovement"("warehouseId", "occurredAt");
CREATE INDEX "InventoryValuationMovement_sku_occurredAt_idx"
ON "InventoryValuationMovement"("sku", "occurredAt");
CREATE INDEX "InventoryValuationMovement_movementType_status_occurredAt_idx"
ON "InventoryValuationMovement"("movementType", "status", "occurredAt");
CREATE INDEX "InventoryValuationMovement_movementId_idx"
ON "InventoryValuationMovement"("movementId");
CREATE UNIQUE INDEX "InventoryValuationSnapshot_lastEventId_key"
ON "InventoryValuationSnapshot"("lastEventId");
CREATE UNIQUE INDEX "InventoryValuationSnapshot_shopId_warehouseId_productId_variantId_key"
ON "InventoryValuationSnapshot"("shopId", "warehouseId", "productId", "variantId");
CREATE INDEX "InventoryValuationSnapshot_shopId_warehouseId_sku_idx"
ON "InventoryValuationSnapshot"("shopId", "warehouseId", "sku");
CREATE INDEX "InventoryValuationSnapshot_asOf_idx"
ON "InventoryValuationSnapshot"("asOf");

ALTER TABLE "InventoryAccountMapping"
ADD CONSTRAINT "InventoryAccountMapping_accountId_fkey"
FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "InventoryValuationMovement"
ADD CONSTRAINT "InventoryValuationMovement_journalEntryId_fkey"
FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;
