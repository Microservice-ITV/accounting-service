ALTER TABLE "JournalEntry"
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE "AccountingOutboxEvent" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "routingKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountingOutboxEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AccountingOutboxEvent_eventId_key"
ON "AccountingOutboxEvent"("eventId");

CREATE INDEX "AccountingOutboxEvent_publishedAt_createdAt_idx"
ON "AccountingOutboxEvent"("publishedAt", "createdAt");
