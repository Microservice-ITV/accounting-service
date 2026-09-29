#!/usr/bin/env bash

set -Eeuo pipefail

MODE="${1:-}"
IMAGE="${2:-}"

DEPLOY_DIR="/var/www/html/microservices/accounting-service"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"

case "$MODE" in
  staging)
    ENV_FILE="$DEPLOY_DIR/.env.staging"
    APP_CONTAINER="accounting-service-staging"
    DB_SERVICE="accounting-db"
    DB_CONTAINER="accounting-db-staging"
    APP_PORT="14005"
    ;;

  production)
    ENV_FILE="$DEPLOY_DIR/.env.prod"
    APP_CONTAINER="accounting-service"
    DB_SERVICE="accounting-db"
    DB_CONTAINER="accounting-db"
    APP_PORT="4005"
    ;;

  *)
    echo "Usage: $0 {staging|production} <image>"
    exit 1
    ;;
esac

if [[ -z "$IMAGE" ]]; then
  echo "❌ Docker image is required"
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "❌ Environment file not found: $ENV_FILE"
  exit 1
fi

if [[ ! -f "$COMPOSE_FILE" ]]; then
  echo "❌ Compose file not found: $COMPOSE_FILE"
  exit 1
fi

cd "$DEPLOY_DIR"

echo "========================================="
echo "🚀 Accounting Service Deployment"
echo "Mode : $MODE"
echo "Image: $IMAGE"
echo "========================================="


#####################################################
# Docker login
#####################################################

if [[ -n "${DOCKER_USERNAME:-}" && -n "${DOCKER_TOKEN:-}" ]]; then

  echo "🔐 Logging into Docker Hub..."

  echo "$DOCKER_TOKEN" |
    docker login \
      --username "$DOCKER_USERNAME" \
      --password-stdin

fi


#####################################################
# Pull immutable image
#####################################################

echo "🐳 Pulling image..."

docker pull "$IMAGE"


#####################################################
# STAGING
#####################################################

if [[ "$MODE" == "staging" ]]; then

  echo "🧪 Starting staging database..."

  export IMAGE_TAG="${IMAGE##*:}"

  docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up -d "$DB_SERVICE"

  echo "⏳ Waiting for staging database..."

  for i in {1..30}; do

    STATUS=$(docker inspect \
      --format='{{.State.Health.Status}}' \
      "$DB_CONTAINER" 2>/dev/null || echo "starting")

    if [[ "$STATUS" == "healthy" ]]; then
      echo "✅ Staging database healthy"
      break
    fi

    if [[ "$i" == "30" ]]; then
      echo "❌ Staging database failed"
      docker logs --tail 150 "$DB_CONTAINER" || true
      exit 1
    fi

    sleep 2

  done


  echo "🚀 Starting staging application..."

  docker rm -f "$APP_CONTAINER" 2>/dev/null || true

  docker run -d \
    --name "$APP_CONTAINER" \
    --restart=no \
    --init \
    --env-file "$ENV_FILE" \
    --network itv-network \
    -p "127.0.0.1:${APP_PORT}:4005" \
    "$IMAGE"


  echo "⏳ Waiting for staging application..."

  for i in {1..30}; do

    STATUS=$(docker inspect \
      --format='{{.State.Status}}' \
      "$APP_CONTAINER" 2>/dev/null || echo "missing")

    if [[ "$STATUS" == "exited" ]]; then
      echo "❌ Staging application exited"
      docker logs --tail 150 "$APP_CONTAINER"
      exit 1
    fi

    HEALTH=$(docker inspect \
      --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' \
      "$APP_CONTAINER" 2>/dev/null || echo "starting")

    echo "Staging: $STATUS / $HEALTH"

    if [[ "$HEALTH" == "healthy" ]]; then
      break
    fi

    if [[ "$i" == "30" ]]; then
      echo "❌ Staging health check failed"
      docker logs --tail 150 "$APP_CONTAINER"
      exit 1
    fi

    sleep 5

  done


  ###################################################
  # Staging smoke test
  ###################################################

  echo "🔍 Running staging smoke test..."

  HTTP_STATUS=$(curl \
    -s \
    -o /dev/null \
    -w "%{http_code}" \
    --max-time 10 \
    "http://127.0.0.1:${APP_PORT}/health" || true)

  if [[ "$HTTP_STATUS" != "200" ]]; then
    echo "❌ Staging smoke test failed"
    docker logs --tail 150 "$APP_CONTAINER"
    exit 1
  fi

  echo "✅ Staging validation passed"

  exit 0

fi


#####################################################
# PRODUCTION
#####################################################

echo "🚀 Starting production deployment..."


#####################################################
# Detect previous image
#####################################################

PREVIOUS_IMAGE=$(docker inspect \
  --format='{{.Config.Image}}' \
  "$APP_CONTAINER" 2>/dev/null || true)

if [[ -n "$PREVIOUS_IMAGE" ]]; then
  echo "💾 Previous image: $PREVIOUS_IMAGE"
else
  echo "ℹ️ No previous production image found"
fi


#####################################################
# Ensure production database is running
#####################################################

export IMAGE_TAG="${IMAGE##*:}"

echo "🐘 Ensuring production database is healthy..."

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up -d "$DB_SERVICE"

for i in {1..30}; do

  STATUS=$(docker inspect \
    --format='{{.State.Health.Status}}' \
    "$DB_CONTAINER" 2>/dev/null || echo "starting")

  if [[ "$STATUS" == "healthy" ]]; then
    echo "✅ Production database healthy"
    break
  fi

  if [[ "$i" == "30" ]]; then
    echo "❌ Production database failed"
    docker logs --tail 150 "$DB_CONTAINER" || true
    exit 1
  fi

  sleep 2

done


#####################################################
# Start new production application
#####################################################

echo "🔄 Replacing production application..."

docker rm -f "$APP_CONTAINER" 2>/dev/null || true

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up -d accounting-app


#####################################################
# Wait for production health
#####################################################

echo "⏳ Waiting for production application..."

HEALTHY=false

for i in {1..30}; do

  STATUS=$(docker inspect \
    --format='{{.State.Status}}' \
    "$APP_CONTAINER" 2>/dev/null || echo "missing")

  if [[ "$STATUS" == "exited" ]]; then
    echo "❌ Production application exited"
    break
  fi

  HEALTH=$(docker inspect \
    --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' \
    "$APP_CONTAINER" 2>/dev/null || echo "starting")

  echo "Production: $STATUS / $HEALTH"

  if [[ "$HEALTH" == "healthy" ]]; then
    HEALTHY=true
    break
  fi

  sleep 5

done


#####################################################
# Rollback function
#####################################################

rollback() {

  echo "========================================="
  echo "🔄 AUTOMATIC ROLLBACK"
  echo "========================================="

  if [[ -z "$PREVIOUS_IMAGE" ]]; then
    echo "🚨 No previous image available"
    exit 1
  fi

  echo "Restoring: $PREVIOUS_IMAGE"

  docker pull "$PREVIOUS_IMAGE"

  docker rm -f "$APP_CONTAINER" 2>/dev/null || true

  docker run -d \
    --name "$APP_CONTAINER" \
    --restart=unless-stopped \
    --init \
    --env-file "$ENV_FILE" \
    --network itv-network \
    -p "127.0.0.1:${APP_PORT}:4005" \
    "$PREVIOUS_IMAGE"


  echo "⏳ Waiting for rollback..."

  for i in {1..30}; do

    STATUS=$(docker inspect \
      --format='{{.State.Status}}' \
      "$APP_CONTAINER" 2>/dev/null || echo "missing")

    if [[ "$STATUS" == "exited" ]]; then
      echo "❌ Rollback application exited"
      docker logs --tail 200 "$APP_CONTAINER" || true
      exit 1
    fi

    HEALTH=$(docker inspect \
      --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}starting{{end}}' \
      "$APP_CONTAINER" 2>/dev/null || echo "starting")

    echo "Rollback: $STATUS / $HEALTH"

    if [[ "$HEALTH" == "healthy" ]]; then
      echo "✅ Rollback successful"
      return 0
    fi

    sleep 5

  done

  echo "🚨 Rollback health check failed"

  docker logs --tail 200 "$APP_CONTAINER" || true

  exit 1
}


#####################################################
# Health failure
#####################################################

if [[ "$HEALTHY" != "true" ]]; then

  echo "❌ New production image failed health check"

  docker logs --tail 200 "$APP_CONTAINER" || true

  rollback

  exit 1

fi


#####################################################
# Production smoke test
#####################################################

echo "🔍 Running production smoke test..."

HTTP_STATUS=$(curl \
  -s \
  -o /dev/null \
  -w "%{http_code}" \
  --max-time 10 \
  "http://127.0.0.1:${APP_PORT}/health" || true)

if [[ "$HTTP_STATUS" != "200" ]]; then

  echo "❌ Production smoke test failed"

  docker logs --tail 200 "$APP_CONTAINER" || true

  rollback

  exit 1

fi


#####################################################
# Final status
#####################################################

echo "📊 Production status..."

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  ps


#####################################################
# Cleanup
#####################################################

echo "🧹 Cleaning unused Docker images..."

docker image prune -f


echo "========================================="
echo "✅ DEPLOYMENT SUCCESSFUL"
echo "========================================="