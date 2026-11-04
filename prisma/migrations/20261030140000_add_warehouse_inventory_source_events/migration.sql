CREATE TABLE "WarehouseInventorySourceEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "lineIndex" INTEGER NOT NULL,
    "eventType" TEXT NOT NULL,
    "correlationId" TEXT NOT NULL,
    "eventTimestamp" TIMESTAMP(3) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "sourceDocumentId" TEXT,
    "sourceDocumentType" TEXT,
    "movementType" TEXT,
    "productId" TEXT,
    "sku" TEXT,
    "variantId" TEXT,
    "shopId" TEXT,
    "warehouseId" TEXT,
    "quantity" DECIMAL(18,4),
    "availableQty" DECIMAL(18,4),
    "onHandQty" DECIMAL(18,4),
    "reportedUnitCost" DECIMAL(18,4),
    "currency" TEXT,
    "blockReason" TEXT NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WarehouseInventorySourceEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "WarehouseInventorySourceEvent_eventId_lineIndex_key"
ON "WarehouseInventorySourceEvent"("eventId", "lineIndex");
CREATE INDEX "WarehouseInventorySourceEvent_shopId_occurredAt_idx"
ON "WarehouseInventorySourceEvent"("shopId", "occurredAt");
CREATE INDEX "WarehouseInventorySourceEvent_warehouseId_occurredAt_idx"
ON "WarehouseInventorySourceEvent"("warehouseId", "occurredAt");
CREATE INDEX "WarehouseInventorySourceEvent_productId_occurredAt_idx"
ON "WarehouseInventorySourceEvent"("productId", "occurredAt");
CREATE INDEX "WarehouseInventorySourceEvent_correlationId_productId_idx"
ON "WarehouseInventorySourceEvent"("correlationId", "productId");
