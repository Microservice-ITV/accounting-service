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

The accounting consumer listens for `payment.completed` and `payment.collected` from the payment service on the existing `order_events` exchange. COD revenue is recognized only from `payment.collected`, using the payment service's existing per-shop allocations. For local Docker testing, point `PAYMENT_RABBITMQ_URL` at the same RabbitMQ broker configured in `payment-service/.env` before starting the accounting service:

```powershell
$env:PAYMENT_RABBITMQ_URL = (Get-Content ..\payment-service\.env | Where-Object { $_ -match '^RABBITMQ_URL=' }).Split('=', 2)[1] -replace '@rabbitmq(?=:)', '@orderservice-rabbitmq'
docker compose up -d --build
```

The consumer uses the durable queue `accounting.payment_completed`, binds it to both payment routing keys, and sends malformed or permanently invalid messages to `accounting.payment_completed.dlq`. Successful events create balanced entries with Cash (`1000`) debited and Revenue (`4000`) credited. COD collection credits Revenue separately for each allocated shop. The event ID and payment reference prevent duplicate journal entries.

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

Journal lines do not currently have a currency field, so their amounts follow the existing accounting convention and are not currency-converted; mixed-currency journal reporting is therefore not represented at the line level.

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
