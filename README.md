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
