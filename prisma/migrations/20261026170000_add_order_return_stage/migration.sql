CREATE TABLE "OrderReturnStage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "reason" TEXT NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RETURNED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderReturnStage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderReturnStage_eventId_key" ON "OrderReturnStage"("eventId");
CREATE UNIQUE INDEX "OrderReturnStage_orderId_key" ON "OrderReturnStage"("orderId");
CREATE INDEX "OrderReturnStage_returnedAt_idx" ON "OrderReturnStage"("returnedAt");
