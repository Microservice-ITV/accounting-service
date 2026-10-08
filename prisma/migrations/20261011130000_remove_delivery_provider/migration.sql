DO $$
DECLARE
  provider_table REGCLASS;
  archive_table REGCLASS;
  constraint_row RECORD;
BEGIN
  IF to_regclass('public."DeliveryProviderFee"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "DeliveryProviderFee" WHERE "providerId" IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot remove DeliveryProviderFee.providerId while provider references remain; resolve them first';
    END IF;
  END IF;
  IF to_regclass('public."Expense"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "Expense" WHERE "deliveryProviderId" IS NOT NULL) THEN
      RAISE EXCEPTION 'Cannot remove Expense.deliveryProviderId while provider references remain; resolve them first';
    END IF;
  END IF;
  IF to_regclass('public."LegacyDeliveryProviderArchive"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "LegacyDeliveryProviderArchive") THEN
      RAISE EXCEPTION 'Cannot drop LegacyDeliveryProviderArchive while archived provider rows remain';
    END IF;
  END IF;
  IF to_regclass('public."DeliveryProvider"') IS NOT NULL THEN
    IF EXISTS (SELECT 1 FROM "DeliveryProvider") THEN
      RAISE EXCEPTION 'Cannot drop DeliveryProvider while provider rows remain';
    END IF;
  END IF;

  provider_table := to_regclass('public."DeliveryProvider"');
  archive_table := to_regclass('public."LegacyDeliveryProviderArchive"');
  FOR constraint_row IN
    SELECT conrelid::REGCLASS AS table_name, conname
    FROM pg_constraint
    WHERE contype = 'f'
      AND confrelid IN (provider_table, archive_table)
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', constraint_row.table_name, constraint_row.conname);
  END LOOP;
END $$;

ALTER TABLE "DeliveryProviderFee" DROP COLUMN IF EXISTS "providerId";
ALTER TABLE "Expense" DROP COLUMN IF EXISTS "deliveryProviderId";

DROP INDEX IF EXISTS "Expense_deliveryProviderId_idx";
DROP INDEX IF EXISTS "delivery_provider_fee_effective_idx";
DROP INDEX IF EXISTS "delivery_provider_fee_shop_company_effective_idx";

ALTER TABLE "DeliveryProviderFee" RENAME TO "delivery_company_fees";

CREATE INDEX "delivery_company_fee_shop_company_effective_idx"
  ON "delivery_company_fees"("shopId", "deliveryCompanyId", "active", "effectiveFrom", "effectiveTo");

DROP TABLE IF EXISTS "LegacyDeliveryProviderArchive";
DROP TABLE IF EXISTS "DeliveryProvider";
