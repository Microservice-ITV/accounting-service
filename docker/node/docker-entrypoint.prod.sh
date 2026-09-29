#!/bin/sh

set -e

echo "Starting Accounting Service..."

echo "Running Prisma migrations..."

npx prisma migrate deploy

echo "Starting production server..."

exec "$@"