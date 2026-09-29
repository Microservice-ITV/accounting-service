#!/usr/bin/env bash

set -Eeuo pipefail

MODE="${1:-}"
IMAGE="${2:-}"

DEPLOY_DIR="/var/www/html/microservices/accounting-service"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"

NETWORK_NAME="itv-network"

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
    DB_SERVICE="accounting-db"
    DB_CONTAINER="accounting-db"

    BLUE_CONTAINER="accounting-service-blue"
    GREEN_CONTAINER="accounting-service-green"

    NGINX_CONTAINER="microservices-gateway"
    NGINX_UPSTREAM_FILE="/etc/nginx/conf.d/accounting-upstream.conf"
    APP_PORT="4005"
    ;;

  *)
    echo "Usage: $0 {staging|production} <image>"
    exit 1
    ;;
esac


#####################################################
# Validation
#####################################################

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


#####################################################
# Helpers
#####################################################

log() {
  echo
  echo "▶ $1"
}

cleanup_image() {
  echo "🧹 Removing failed image..."
  docker image rm "$IMAGE" 2>/dev/null || true
}

wait_for_db() {
  local container="$1"

  echo "⏳ Waiting for database..."

  for i in {1..30}; do
    local status

    status=$(docker inspect \
      --format='{{.State.Health.Status}}' \
      "$container" 2>/dev/null || echo "starting")

    if [[ "$status" == "healthy" ]]; then
      echo "✅ Database healthy"
      return 0
    fi

    if [[ "$i" == "30" ]]; then
      echo "❌ Database failed health check"
      docker logs --tail 150 "$container" || true
      return 1
    fi

    sleep 2
  done
}


wait_for_http() {
  local container="$1"
  local url="$2"
  local label="$3"

  echo "⏳ Waiting for $label..."

  for i in {1..30}; do

    local status
    status=$(docker inspect \
      --format='{{.State.Status}}' \
      "$container" 2>/dev/null || echo "missing")

    if [[ "$status" == "exited" ]]; then
      echo "❌ $label container exited"
      docker logs --tail 200 "$container" || true
      return 1
    fi

    if [[ "$status" != "running" ]]; then
      echo "$label: $status"
      sleep 5
      continue
    fi

    local http_status

    http_status=$(curl \
      -s \
      -o /dev/null \
      -w "%{http_code}" \
      --max-time 5 \
      "$url" || true)

    echo "$label: $status / HTTP $http_status"

    if [[ "$http_status" == "200" ]]; then
      echo "✅ $label healthy"
      return 0
    fi

    sleep 5
  done

  echo "❌ $label health check failed"
  docker logs --tail 200 "$container" || true

  return 1
}


#####################################################
# Docker login
#####################################################

log "Docker login"

if [[ -n "${DOCKER_USERNAME:-}" && -n "${DOCKER_TOKEN:-}" ]]; then

  echo "$DOCKER_TOKEN" |
    docker login \
      --username "$DOCKER_USERNAME" \
      --password-stdin

fi


#####################################################
# Pull image
#####################################################

log "Pulling image"

if ! docker pull "$IMAGE"; then
  echo "❌ Failed to pull image"
  exit 1
fi


#####################################################
# STAGING
#####################################################

if [[ "$MODE" == "staging" ]]; then

  export IMAGE_TAG="${IMAGE##*:}"

  ###################################################
  # Database
  ###################################################

  log "Starting staging database"

  docker compose \
    --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up -d "$DB_SERVICE"

  if ! wait_for_db "$DB_CONTAINER"; then
    cleanup_image
    exit 1
  fi


  ###################################################
  # Remove old staging container
  ###################################################

  log "Removing previous staging container"

  docker rm -f "$APP_CONTAINER" 2>/dev/null || true


  ###################################################
  # Start staging application
  ###################################################

  log "Starting staging application"

  if ! docker run -d \
    --name "$APP_CONTAINER" \
    --restart=no \
    --init \
    --env-file "$ENV_FILE" \
    --network "$NETWORK_NAME" \
    -p "127.0.0.1:${APP_PORT}:4005" \
    "$IMAGE"; then

    echo "❌ Failed to start staging application"

    docker rm -f "$APP_CONTAINER" 2>/dev/null || true
    cleanup_image
    exit 1
  fi


  ###################################################
  # Health check
  ###################################################

  if ! wait_for_http \
    "$APP_CONTAINER" \
    "http://127.0.0.1:${APP_PORT}/health" \
    "Staging application"; then

    docker rm -f "$APP_CONTAINER" 2>/dev/null || true
    cleanup_image
    exit 1
  fi


  ###################################################
  # Smoke test
  ###################################################

  log "Running staging smoke test"

  HTTP_STATUS=$(curl \
    -s \
    -o /dev/null \
    -w "%{http_code}" \
    --max-time 10 \
    "http://127.0.0.1:${APP_PORT}/health" || true)

  if [[ "$HTTP_STATUS" != "200" ]]; then

    echo "❌ Staging smoke test failed"

    docker logs --tail 200 "$APP_CONTAINER" || true
    docker rm -f "$APP_CONTAINER" 2>/dev/null || true
    cleanup_image

    exit 1
  fi


  ###################################################
  # Staging success
  ###################################################

  echo
  echo "========================================="
  echo "✅ STAGING VALIDATION PASSED"
  echo "========================================="

  exit 0
fi


#####################################################
# PRODUCTION
#####################################################

echo
echo "========================================="
echo "🚀 ZERO-DOWNTIME PRODUCTION DEPLOYMENT"
echo "========================================="


#####################################################
# Production database
#####################################################

log "Ensuring production database is healthy"

export IMAGE_TAG="${IMAGE##*:}"

docker compose \
  --env-file "$ENV_FILE" \
  -f "$COMPOSE_FILE" \
  up -d "$DB_SERVICE"

if ! wait_for_db "$DB_CONTAINER"; then
  cleanup_image
  exit 1
fi


#####################################################
# Detect active container
#####################################################

CURRENT_CONTAINER=""

if docker ps --format '{{.Names}}' | grep -qx "$BLUE_CONTAINER"; then
  CURRENT_CONTAINER="$BLUE_CONTAINER"
elif docker ps --format '{{.Names}}' | grep -qx "$GREEN_CONTAINER"; then
  CURRENT_CONTAINER="$GREEN_CONTAINER"
fi


#####################################################
# Select inactive color
#####################################################

if [[ "$CURRENT_CONTAINER" == "$BLUE_CONTAINER" ]]; then
  NEW_CONTAINER="$GREEN_CONTAINER"
elif [[ "$CURRENT_CONTAINER" == "$GREEN_CONTAINER" ]]; then
  NEW_CONTAINER="$BLUE_CONTAINER"
else
  NEW_CONTAINER="$BLUE_CONTAINER"
fi


echo
echo "Current container : ${CURRENT_CONTAINER:-none}"
echo "New container     : $NEW_CONTAINER"


#####################################################
# Remove inactive container
#####################################################

log "Cleaning inactive deployment"

docker rm -f "$NEW_CONTAINER" 2>/dev/null || true


#####################################################
# Start new container
#####################################################

log "Starting new production container"

if ! docker run -d \
  --name "$NEW_CONTAINER" \
  --restart=unless-stopped \
  --init \
  --env-file "$ENV_FILE" \
  --network "$NETWORK_NAME" \
  "$IMAGE"; then

  echo "❌ Failed to start new production container"

  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  cleanup_image

  exit 1
fi


#####################################################
# Health check new container
#####################################################

if ! wait_for_http \
  "$NEW_CONTAINER" \
  "http://${NEW_CONTAINER}:4005/health" \
  "New production application"; then

  echo
  echo "❌ New production deployment failed"

  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  cleanup_image

  echo "✅ Existing production container remains untouched"

  exit 1
fi


#####################################################
# Verify from Docker network
#####################################################

log "Running internal production smoke test"

SMOKE_STATUS=$(docker run --rm \
  --network "$NETWORK_NAME" \
  curlimages/curl:8.10.1 \
  -s \
  -o /dev/null \
  -w "%{http_code}" \
  --max-time 10 \
  "http://${NEW_CONTAINER}:4005/health" || true)

if [[ "$SMOKE_STATUS" != "200" ]]; then

  echo "❌ Internal production smoke test failed"

  docker logs --tail 200 "$NEW_CONTAINER" || true
  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  cleanup_image

  echo "✅ Existing production container remains untouched"

  exit 1
fi


#####################################################
# Switch Nginx traffic
#####################################################

log "Switching Nginx traffic"

echo "upstream accounting_service_backend {" \
  > /tmp/accounting-upstream.conf

echo "    server ${NEW_CONTAINER}:4005;" \
  >> /tmp/accounting-upstream.conf

echo "}" \
  >> /tmp/accounting-upstream.conf


docker cp \
  /tmp/accounting-upstream.conf \
  "${NGINX_CONTAINER}:${NGINX_UPSTREAM_FILE}"


#####################################################
# Validate Nginx configuration
#####################################################

log "Validating Nginx configuration"

if ! docker exec "$NGINX_CONTAINER" nginx -t; then

  echo "❌ Nginx configuration validation failed"

  echo "🔄 Keeping existing production container"

  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  cleanup_image

  exit 1
fi


#####################################################
# Reload Nginx
#####################################################

log "Reloading Nginx"

if ! docker exec "$NGINX_CONTAINER" nginx -s reload; then

  echo "❌ Nginx reload failed"

  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  cleanup_image

  exit 1
fi


#####################################################
# Verify traffic after switch
#####################################################

log "Verifying production traffic"

TRAFFIC_OK=false

for i in {1..10}; do

  HTTP_STATUS=$(curl \
    -s \
    -o /dev/null \
    -w "%{http_code}" \
    --max-time 5 \
    "http://127.0.0.1/health" || true)

  echo "Gateway: HTTP $HTTP_STATUS"

  if [[ "$HTTP_STATUS" == "200" ]]; then
    TRAFFIC_OK=true
    break
  fi

  sleep 2
done


#####################################################
# Traffic rollback
#####################################################

if [[ "$TRAFFIC_OK" != "true" ]]; then

  echo "❌ Production traffic verification failed"

  if [[ -n "$CURRENT_CONTAINER" ]]; then

    echo "🔄 Rolling traffic back to $CURRENT_CONTAINER"

    echo "upstream accounting_service_backend {" \
      > /tmp/accounting-upstream.conf

    echo "    server ${CURRENT_CONTAINER}:4005;" \
      >> /tmp/accounting-upstream.conf

    echo "}" \
      >> /tmp/accounting-upstream.conf

    docker cp \
      /tmp/accounting-upstream.conf \
      "${NGINX_CONTAINER}:${NGINX_UPSTREAM_FILE}"

    if docker exec "$NGINX_CONTAINER" nginx -t; then
      docker exec "$NGINX_CONTAINER" nginx -s reload
      echo "✅ Traffic rollback completed"
    else
      echo "🚨 CRITICAL: Nginx rollback configuration failed"
    fi

  fi

  docker rm -f "$NEW_CONTAINER" 2>/dev/null || true
  cleanup_image

  exit 1
fi


#####################################################
# Remove previous container
#####################################################

if [[ -n "$CURRENT_CONTAINER" ]]; then

  log "Removing previous production container"

  docker rm -f "$CURRENT_CONTAINER" 2>/dev/null || true

else

  echo "ℹ️ No previous production container"
fi


#####################################################
# Cleanup dangling images
#####################################################

log "Cleaning dangling Docker images"

docker image prune -f


#####################################################
# Final status
#####################################################

echo
echo "📊 Production containers:"

docker ps \
  --filter "name=accounting-service-" \
  --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"


echo
echo "========================================="
echo "✅ ZERO-DOWNTIME DEPLOYMENT SUCCESSFUL"
echo "========================================="
echo "Active container : $NEW_CONTAINER"
echo "Image            : $IMAGE"
echo "========================================="