CREATE TABLE "PnlOrderShop" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopOrderId" TEXT,
    "sourceEventId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'MMK',
    "grossItemSales" DECIMAL(10,2) NOT NULL,
    "discountTotal" DECIMAL(10,2) NOT NULL,
    "shippingTotal" DECIMAL(10,2) NOT NULL,
    "paidAmount" DECIMAL(10,2) NOT NULL,
    "discountAllocationsComplete" BOOLEAN NOT NULL DEFAULT false,
    "orderPaidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PnlOrderShop_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PnlOrderDiscountAllocation" (
    "id" TEXT NOT NULL,
    "pnlOrderShopId" TEXT NOT NULL,
    "promotionId" TEXT,
    "rewardId" TEXT,
    "discountType" TEXT NOT NULL,
    "fundedBy" TEXT NOT NULL,
    "amount" DECIMAL(10,2) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PnlOrderDiscountAllocation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PnlOrderShop_orderId_shopId_key" ON "PnlOrderShop"("orderId", "shopId");
CREATE INDEX "PnlOrderShop_shopId_orderPaidAt_idx" ON "PnlOrderShop"("shopId", "orderPaidAt");
CREATE INDEX "PnlOrderShop_sourceEventId_idx" ON "PnlOrderShop"("sourceEventId");
CREATE INDEX "PnlOrderDiscountAllocation_pnlOrderShopId_discountType_fundedBy_idx" ON "PnlOrderDiscountAllocation"("pnlOrderShopId", "discountType", "fundedBy");

ALTER TABLE "PnlOrderDiscountAllocation"
ADD CONSTRAINT "PnlOrderDiscountAllocation_pnlOrderShopId_fkey"
FOREIGN KEY ("pnlOrderShopId") REFERENCES "PnlOrderShop"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
