# Accounting Service

A dedicated microservice for income and expense accounting, built with Node.js, TypeScript, Prisma, and PostgreSQL.

## Stack
- Node.js + TypeScript
- PostgreSQL
- Prisma ORM
- RabbitMQ
- Express

## Setup

```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev --name init_accounting
npm run dev
```

## Docker infrastructure

```bash
docker compose up -d
```

## Health check

```bash
curl http://localhost:4005/health
```

## Payment accounting integration

The accounting consumer listens for `payment.completed`, `payment.collected`, and `order.paid` on the existing `order_events` exchange. `payment.completed` recognizes successful non-COD payments; a COD completion is deferred. In the COD checkout flow, Order Service authorizes the COD payment after address and shipping totals are finalized, creates the order, and then emits `order.paid` with `payment_status: COD`, payment identity, currency, and per-shop totals. Accounting uses that event to debit COD Receivable (`1200`) and credit Revenue (`4000`) once per order/shop. The separate `order.created` checkout event is not sufficient evidence: it has no order ID or COD/payment status and precedes authoritative order/shop allocations.

The Delivery Service emits `shipment.delivered` with order, shop, and delivery timestamps. Accounting resolves the COD amount, currency, payment identity, and order/shop attribution from the existing `PnlOrderShop` projection, verifies the posted COD revenue journal, then debits COD Collection Clearing (`1210`) and credits COD Receivable (`1200`) once per order/shop. This delivery-stage transfer does not credit revenue again.

When the Shop Admin uses the existing **Collect COD orders** action, Payment Service records the COD payment as `COLLECTED` and emits `payment.collected` with payment/order IDs, total amount, currency, full per-shop allocations, and collection time. Accounting currently uses this event to debit Bank Account (`1010`) / credit COD Collection Clearing (`1210`) once per payment/shop, after validating against the COD projection and prior delivery-stage clearing journal. In the inspected producer flow, `payment.collected` means courier/delivery-agent collection; it is not independent evidence that funds reached the business bank. The existing journal posting is preserved, but account `1010` must not be interpreted as bank-verified solely from this event. Collection events arriving before delivery accounting are retried. Stable operation references and transaction-scoped locks protect against duplicate events. COD order revenue remains a separate `order.paid` journal: debit COD Receivable (`1200`) / credit Revenue (`4000`).

Account `1010` is seeded as Bank Account and is added by the COD bank-account migration when absent.

## AR/AP ledger reports

The Accounting Service exposes read-only, authenticated journal projections:

- `GET /api/v1/reports/ar-ap` returns posted balances for accounts `1010`, `1100`, `1200`, `1210`, `2000`, and `2100`, order-level receivable movements where the journal reference supports an order ID, existing settlement records, and recorded account-`1010` debit movements. Optional `shopId` is checked against the authenticated shop scope; optional `currency` filters the report. Different currencies are never combined.
- `GET /api/v1/reports/ar-ap/transactions` lists source journals and their visible journal lines. Optional `shopId`, `currency`, `bucket` (`receivables`, `cod_clearing`, `payables`, or `recorded_receipts`), `limit`, and `offset` filters are supported.
- `GET /api/v1/reports/ar-ap/transactions/{referenceType}/{referenceId}` drills into a source journal reference. Shop users see only lines attributed to their authorized shops; platform finance users can see the full journal.
- `GET /api/v1/reports/ar-ap/aging` reports aging as unavailable until reliable invoice/due dates exist in Accounting-owned records.
- `GET /api/v1/reports/ar-ap/invoices` lists read-only invoice snapshots received from Invoice Service events. Optional `shopId`, `status`, `currency`, `invoiceDateFrom`, `invoiceDateTo`, `limit`, and `offset` filters are supported; shop access is checked against the authenticated shop scope.

These are ledger views, not new posting or payment-allocation workflows. Invoice snapshots are separate from GL control-account balances; `grand_total` is the invoice total, not outstanding balance. Due dates, verified payment allocations, exact outstanding balances, and invoice aging are unavailable from the consumed events. COD collection clearing (`1210`) is separate from customer receivables. Invoice notification events never create journals. `payment.collected` and `PaymentSettlement.status = POSTED` are shown as existing Accounting records, not independent bank evidence or proof of customer payment. Account `2000` includes delivery-fee payable postings and is not supplier-only; account `2100` is shown only when posted ledger entries exist. Supplier invoices, open expense AP, payment allocations, credit/debit notes, reliable due dates, and expected income are not fabricated when source records are unavailable. The reports do not create opening balances or change existing journal behavior.

Invoice snapshots are consumed from the existing `order_events` topic exchange using `invoice.generated` and `invoice.paid`. Accounting keeps a dedicated durable queue (`accounting.invoice_projection`), delayed retry queue, and DLQ; override them with `RABBITMQ_INVOICE_PROJECTION_QUEUE`, `RABBITMQ_INVOICE_PROJECTION_RETRY_QUEUE`, and `RABBITMQ_INVOICE_PROJECTION_DLQ`. `RABBITMQ_INVOICE_PROJECTION_RETRY_DELAY_MS` and `RABBITMQ_INVOICE_PROJECTION_MAX_RETRIES` configure bounded retries. The projection stores only invoice identifiers, shop/customer IDs, invoice date, payment method/status, currency, total, and event-status metadata. A `PAID` observation is not downgraded by a late `invoice.generated` event. Invoice event processing is snapshot-only and does not post GL entries.

For local Docker testing, configure the Payment Service broker URL as described below:

```powershell
$env:PAYMENT_RABBITMQ_URL = (Get-Content ..\payment-service\.env | Where-Object { $_ -match '^RABBITMQ_URL=' }).Split('=', 2)[1] -replace '@rabbitmq(?=:)', '@orderservice-rabbitmq'
docker compose up -d --build
```

The consumer uses the durable queue `accounting.payment_completed`, binds it to all three routing keys, and sends malformed, unsupported, or permanently invalid messages to `accounting.payment_completed.dlq`. COD journals retain currency and shop attribution on each line. Collection arriving before COD order recognition is retryable; projection or allocation mismatches are rejected rather than posted.

Order projections created before COD payment metadata was stored have no reliable payment status or payment ID. Replay their original `order.paid` events through the Accounting consumer to establish the COD attribution and recognition journal before processing COD collection; projection-only recovery does not create that journal. Accounting does not guess that an unknown status is non-COD.

Production and staging deployments must run an image built from the current Accounting Service source. The consumer dispatches `payment.completed`, `payment.collected`, and `order.paid` by each payload's `event` field; an older image that assumes every message is `payment.completed` will reject the other two event types. Set all three routing keys in the deployment environment and rebuild/redeploy the image when updating the consumer.

To verify an entry after publishing a successful payment event:

```powershell
Invoke-RestMethod http://localhost:4005/api/v1/entries/reference/PAYMENT/<payment-id> | ConvertTo-Json -Depth 8
```

The RabbitMQ consumer acknowledges a message only after the journal transaction commits. Failed database operations are requeued; malformed or invalid events are dead-lettered.

## Shop delivery expense integration

Shop-paid `PER_ORDER` delivery expenses are created from the Delivery Service `shipment.delivered` event, not from `order.paid` or customer checkout shipping charges. `PER_INVOICE` expenses are created from `payment.collected` events emitted for a persisted Collect COD batch. The batch uses an internal stable group ID and its selected order IDs; it does not use a provider invoice number or the calendar date. Shipping Service owns the global Delivery Company catalog; Accounting stores shop-scoped fee rules using the company ID, charging basis, amount, and currency.

Delivery Company fee rules are runtime-managed through the Accounting API and are not created by the seed script. Configure a fee using an existing Delivery Company ID; use effective-dated rules to change the amount or charging basis without relying on company names or seeded IDs.

Accounting uses canonical shop and Delivery Company IDs. A delivery with missing shop attribution or multiple distinct shop IDs is rejected to the shipment-delivered dead-letter queue; Accounting does not split a single company fee across shops. Customer-paid delivery charges are not used.

For `PER_ORDER`, Accounting records one charge per shop/company/order. For `PER_INVOICE`, one Collect COD batch creates one charge per shop/company/group using the configured fee once, and the expense links every order in that group. Different batches remain separate even when collected on the same day. Stable references and a transaction-scoped PostgreSQL advisory lock prevent duplicate expense and journal creation on retries or concurrent events. Each accepted charge creates an approved expense and a balanced debit to Operating Expenses (`5000`) and credit to Cash (`1000`).

Journal lines retain currency and optional shop attribution. Amounts are not currency-converted; mixed-currency journal reporting must keep currency in view.

## Journal-entry CQRS projection

PostgreSQL remains the accounting write model. Every journal-entry insert or replacement writes an `AccountingOutboxEvent` in the same Prisma transaction. The outbox publisher sends durable `accounting.journal-entry.upserted` events to the `accounting.events` topic exchange and marks them published only after RabbitMQ confirms delivery. At service startup it also queues one snapshot per existing entry, so the read model can be populated without manually copying database records.

The `ecommerce-read-service` consumes those events into its MongoDB `accounting_journal_entry_reads` collection. The authenticated read endpoint is `GET /accounting/entries` on that service; accounting admin and seller journal screens read from this projection. The projection is eventually consistent with the PostgreSQL write model.

Apply the included Prisma migration before deploying the updated accounting service:

```bash
npx prisma migrate deploy
```

The publisher uses `ACCOUNTING_EVENTS_EXCHANGE` (default `accounting.events`) and `ACCOUNTING_JOURNAL_ENTRY_ROUTING_KEY` (default `accounting.journal-entry.upserted`). Configure the ecommerce read service with the same exchange and the `ACCOUNTING_READ_QUEUE` and `ACCOUNTING_EVENT_ROUTING_KEYS` values from its environment example.

## Record an expense

Create a balanced expense entry. The default accounts are Operating Expenses (`5000`) and Cash (`1000`):

```powershell
Invoke-RestMethod -Method Post http://localhost:4005/api/v1/expenses `
	-ContentType 'application/json' `
	-Body '{"referenceId":"office-supplies-2026-09","amount":125.50,"description":"Office supplies"}'
```

Use `expenseAccountCode` and `fundingAccountCode` to select other seeded accounts. The expense account must have type `EXPENSE`, and the funding account cannot be an income or expense account.

## Main responsibilities
- Record journal entries
- Validate debit/credit balance
- Track account balances
- Provide financial reports
- Consume and publish accounting events
