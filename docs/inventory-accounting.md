# Inventory valuation accounting integration

Accounting accepts only the strict `inventory.valuation.movement` v1 envelope defined by the
warehouse-to-accounting contract. The consumer persists valid envelopes before acknowledging
RabbitMQ. A movement with unknown/unreconciled cost, an unsupported movement type, a stale
valuation version, or a missing/invalid Finance mapping remains in the durable inbox as
`BLOCKED`; `POST /api/v1/inventory/valuations/replay-blocked` retries it after correction.

No inventory accounts are seeded and no chart-of-accounts codes are embedded in this integration.
Finance configures mappings by selecting existing Account IDs. The API checks that each selected
account is active and has the role's required account type. Mapping writes require the platform
permission `finance.account-mapping.write`; mapping reads require platform `finance.read`.
Supported posting roles are `INVENTORY_ASSET` (ASSET), `COGS` (EXPENSE),
`PURCHASE_CLEARING` (LIABILITY), and `OPENING_BALANCE_EQUITY` (EQUITY).

`SALE_ISSUED` posts actual movement cost to COGS and reduces inventory. Purchases, supplier
returns, and opening balances use their matching Finance-approved mappings. Transfers update
warehouse valuation projections but do not change consolidated inventory value and therefore do
not create a journal entry. `RETURN_RECEIVED` and other movement types are retained but blocked
until their source-document semantics and accounting treatment are verified.

`GET /api/v1/reports/inventory-valuation` returns distinct dashboard fields:
`inventoryValueMmk` is the latest accepted stock valuation at the requested `to` cutoff;
`purchaseCostMmk` is the period's posted `PURCHASE_RECEIVED` movement cost; `cogsMmk` is the
period's posted `SALE_ISSUED` actual movement cost; and `purchaseReturnsMmk` is the period's
posted supplier-return movement cost. Each field is null when its required source rows/costs are
not established. `landedCostMmk`, `salesReturnsMmk`, `damagedStockValueMmk`, and
`inventoryAdjustmentsMmk` are explicitly null because the event contract does not independently
identify those costs or verified source events. The response has separate `missingComponents`
entries for each unavailable source. It also retains `openingInventoryValueMmk` when a date range
has a known pre-period snapshot.

`reconciliationVarianceMmk` is deliberately null: checking snapshot value against quantity × WAC
is a valuation-consistency check, not an independent ledger reconciliation. An independent
inventory subledger/account balance source is needed before a variance can be reported.

For dated reports, flow metrics use events in `[from, to]`; the inventory value and per-SKU
valuation use the latest accepted event at or before `to`. The latest pre-`from` valuation is the
opening snapshot; absence of that snapshot is reported as unknown, never as zero. Shop, warehouse,
and SKU filters apply to both historical and in-period rows. Report completeness also requires
`INVENTORY_VALUATION_COVERAGE_FROM`, opening valuation data for dated periods, valid account
mappings, and no blocked or unverified movement rows.

The current source contract does not provide a separate sale-return event, landed-cost allocation,
damaged-stock event, or inventory-adjustment event. A verified sale-return event (with authoritative
return quantity/cost and source-document semantics), and explicit landed-cost, damage, and
adjustment sources are required before these fields can be populated or posted.

The Accounting consumer and queue binding are implemented here; the current Warehouse source
does not yet publish this valuation event. Warehouse must emit the documented v1 envelope to the
configured exchange/routing key before end-to-end event delivery can be verified.
