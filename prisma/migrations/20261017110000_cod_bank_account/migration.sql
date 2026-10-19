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
    'cod-bank-account',
    '1010',
    'Bank Account',
    'ASSET'::"AccountType",
    'ACTIVE',
    'ACCOUNT',
    'Bank funds received from COD courier remittances',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
WHERE NOT EXISTS (SELECT 1 FROM "Account" WHERE "code" = '1010');
