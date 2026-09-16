#!/bin/sh
set -e

cd /var/www/html/accounting-service

echo "🚀 Starting Accounting Service..."

echo "🔍 Checking DATABASE_URL..."

echo "DB (shell): $DATABASE_URL"

if [ -z "$DATABASE_URL" ]; then
  echo "❌ DATABASE_URL is missing!"
  exit 1
fi

echo "⏳ Waiting for database..."

if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
    echo "📦 Running Prisma migrations..."
    DATABASE_URL="$DATABASE_URL" \
    npx prisma migrate deploy --schema=./prisma/schema.prisma
fi

if [ "${RUN_SEED:-false}" = "true" ]; then
    echo "🌱 Running Prisma seed..."
    DATABASE_URL="$DATABASE_URL" \
    npm run prisma:seed
fi

echo "✅ Starting application..."

exec "$@"
