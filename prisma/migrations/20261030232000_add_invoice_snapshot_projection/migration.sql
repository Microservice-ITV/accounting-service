CREATE TABLE "InvoiceProjection" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "invoiceDate" TIMESTAMP(3) NOT NULL,
    "paymentMethod" TEXT,
    "observedStatus" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "invoiceTotal" DECIMAL(12,2) NOT NULL,
    "statusEventId" TEXT NOT NULL,
    "statusEventType" TEXT NOT NULL,
    "statusObservedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "InvoiceProjection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "InvoiceEventInbox" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InvoiceEventInbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "InvoiceProjection_invoiceId_key"
ON "InvoiceProjection"("invoiceId");

CREATE INDEX "InvoiceProjection_shopId_invoiceDate_idx"
ON "InvoiceProjection"("shopId", "invoiceDate");

CREATE INDEX "InvoiceProjection_shopId_observedStatus_invoiceDate_idx"
ON "InvoiceProjection"("shopId", "observedStatus", "invoiceDate");

CREATE INDEX "InvoiceProjection_currency_invoiceDate_idx"
ON "InvoiceProjection"("currency", "invoiceDate");

CREATE UNIQUE INDEX "InvoiceEventInbox_eventId_key"
ON "InvoiceEventInbox"("eventId");

CREATE INDEX "InvoiceEventInbox_invoiceId_processedAt_idx"
ON "InvoiceEventInbox"("invoiceId", "processedAt");
