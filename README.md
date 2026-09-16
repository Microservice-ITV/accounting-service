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

The accounting consumer listens for the payment service's existing `payment.completed` event on the `order_events` exchange. For local Docker testing, point `PAYMENT_RABBITMQ_URL` at the same RabbitMQ broker configured in `payment-service/.env` before starting the accounting service:

```powershell
$env:PAYMENT_RABBITMQ_URL = (Get-Content ..\payment-service\.env | Where-Object { $_ -match '^RABBITMQ_URL=' }).Split('=', 2)[1]
docker compose up -d --build
```

The consumer uses the durable queue `accounting.payment_completed`, binds it to `payment.completed`, and sends malformed or permanently invalid messages to `accounting.payment_completed.dlq`. Successful events create a balanced entry with Cash (`1000`) debited and Revenue (`4000`) credited. The event ID is unique in `JournalEntry`, so duplicate deliveries are acknowledged without creating duplicate entries.

To verify an entry after publishing a successful payment event:

```powershell
Invoke-RestMethod http://localhost:4005/api/v1/entries/reference/PAYMENT/<payment-id> | ConvertTo-Json -Depth 8
```

The RabbitMQ consumer acknowledges a message only after the journal transaction commits. Failed database operations are requeued; malformed or invalid events are dead-lettered.

## Main responsibilities
- Record journal entries
- Validate debit/credit balance
- Track account balances
- Provide financial reports
- Consume and publish accounting events
