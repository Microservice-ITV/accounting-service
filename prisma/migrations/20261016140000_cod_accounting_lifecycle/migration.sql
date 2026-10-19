ALTER TABLE "PnlOrderShop"
ADD COLUMN "paymentId" TEXT,
ADD COLUMN "paymentStatus" TEXT;

ALTER TABLE "EntryLine"
ADD COLUMN "currency" TEXT,
ADD COLUMN "shopId" TEXT;

CREATE INDEX "PnlOrderShop_paymentStatus_idx" ON "PnlOrderShop"("paymentStatus");
CREATE INDEX "EntryLine_shopId_currency_idx" ON "EntryLine"("shopId", "currency");

INSERT INTO "Account" (
    "id",
    "code",
    "name",
    "type",
    "status",
    "statusDomain",
    "description",
    "createdAt",
    "updatedAt"
)
SELECT
    'cod-receivable-account',
    '1200',
    'COD Receivable',
    'ASSET'::"AccountType",
    'ACTIVE',
    'ACCOUNT',
    'Amounts due from customers for cash-on-delivery orders',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '1200');

INSERT INTO "Account" (
    "id",
    "code",
    "name",
    "type",
    "status",
    "statusDomain",
    "description",
    "createdAt",
    "updatedAt"
)
SELECT
    'cod-collection-clearing-account',
    '1210',
    'COD Collection Clearing',
    'ASSET'::"AccountType",
    'ACTIVE',
    'ACCOUNT',
    'Courier-collected COD funds not yet confirmed as settled to bank',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '1210');
