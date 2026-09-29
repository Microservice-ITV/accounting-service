#!/usr/bin/env bash

set -Eeuo pipefail

MODE="${1:-}"
IMAGE="${2:-}"

DEPLOY_DIR="/var/www/html/microservices/accounting-service"
GATEWAY_DIR="/var/www/html/microservices/gateway"
GATEWAY_NGINX_DIR="$GATEWAY_DIR/nginx"

COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
NETWORK_NAME="itv-network"

NGINX_CONTAINER="microservices-gateway"
NGINX_UPSTREAM_FILE="$GATEWAY_NGINX_DIR/accounting-service-upstream.conf"

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
    LEGACY_CONTAINER="accounting-service"

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

if [[ "$MODE" == "production" && ! -d "$GATEWAY_NGINX_DIR" ]]; then
  echo "❌ Gateway Nginx directory not found: $GATEWAY_NGINX_DIR"
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
  docker image rm "$IMAGE" >/dev/null 2>&1 || true
}

container_exists() {
  docker container inspect "$1" >/dev/null 2>&1
}

container_running() {
  [[ "$(docker inspect \
    --format='{{.State.Status}}' \
    "$1" 2>/dev/null || true)" == "running" ]]
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

    if [[ "$status" == "unhealthy" ]]; then
      echo "❌ Database is unhealthy"
      docker logs --tail 150 "$container" || true
      return 1
    fi

    echo "Database: $status ($i/30)"
    sleep 2
  done

  echo "❌ Database failed health check"
  docker logs --tail 150 "$container" || true

  return 1
}

wait_for_container_health() {
  local container="$1"
  local label="$2"

  echo "⏳ Waiting for $label..."

  for i in {1..30}; do

    if ! container_exists "$container"; then
      echo "⏳ Container not created yet... ($i/30)"
      sleep 2
      continue
    fi

    local status

    status=$(docker inspect \
      --format='{{.State.Status}}' \
      "$container" 2>/dev/null || echo "missing")

    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      echo "❌ $label container exited"

      docker logs --tail 200 "$container" || true

      return 1
    fi

    if [[ "$status" != "running" ]]; then
      echo "$label: $status ($i/30)"
      sleep 2
      continue
    fi

    if docker exec "$container" node -e '
      const http = require("http");

      const req = http.get(
        "http://127.0.0.1:4005/health",
        res => {
          process.exit(res.statusCode === 200 ? 0 : 1);
        }
      );

      req.on("error", () => process.exit(1));

      req.setTimeout(5000, () => {
        req.destroy();
        process.exit(1);
      });
    ' >/dev/null 2>&1; then

      echo "✅ $label healthy"
      return 0
    fi

    echo "$label: starting ($i/30)"
    sleep 2
  done

  echo "❌ $label health check failed"
  docker logs --tail 200 "$container" || true

  return 1
}

get_active_container() {
  local active=""

  # Prefer the persistent Nginx upstream state.
  if [[ -f "$NGINX_UPSTREAM_FILE" ]]; then
    active=$(sed -n \
      's/^[[:space:]]*server[[:space:]]\+\([^:;[:space:]]*\):4005;.*/\1/p' \
      "$NGINX_UPSTREAM_FILE" \
      | head -n 1)
  fi

  if [[ -n "$active" ]] && container_running "$active"; then
    echo "$active"
    return 0
  fi

  # Fallback: detect blue/green.
  if container_running "$BLUE_CONTAINER"; then
    echo "$BLUE_CONTAINER"
    return 0
  fi

  if container_running "$GREEN_CONTAINER"; then
    echo "$GREEN_CONTAINER"
    return 0
  fi

  # Fallback: detect old single-container deployment.
  if container_running "$LEGACY_CONTAINER"; then
    echo "$LEGACY_CONTAINER"
    return 0
  fi

  echo ""
}

get_new_container() {
  local current="$1"

  if [[ "$current" == "$BLUE_CONTAINER" ]]; then
    echo "$GREEN_CONTAINER"
  else
    echo "$BLUE_CONTAINER"
  fi
}

write_upstream() {
  local container="$1"
  local target="$2"

  cat > "$target" <<EOF
upstream accounting_service_backend {
    server ${container}:4005;
}
EOF
}

switch_nginx() {
  local new_container="$1"
  local previous_file=""
  local backup_file=""

  previous_file=$(mktemp)
  backup_file=$(mktemp)

  if [[ -f "$NGINX_UPSTREAM_FILE" ]]; then
    cp "$NGINX_UPSTREAM_FILE" "$backup_file"
  fi

  cp "$NGINX_UPSTREAM_FILE" "$previous_file" 2>/dev/null || true

  write_upstream "$new_container" "$NGINX_UPSTREAM_FILE"

  if ! docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
    echo "❌ Nginx configuration validation failed"

    if [[ -s "$previous_file" ]]; then
      cp "$previous_file" "$NGINX_UPSTREAM_FILE"
    else
      rm -f "$NGINX_UPSTREAM_FILE"
    fi

    rm -f "$previous_file" "$backup_file"

    return 1
  fi

  if ! docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1; then
    echo "❌ Nginx reload failed"

    if [[ -s "$previous_file" ]]; then
      cp "$previous_file" "$NGINX_UPSTREAM_FILE"
    else
      rm -f "$NGINX_UPSTREAM_FILE"
    fi

    docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1 || true
    docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true

    rm -f "$previous_file" "$backup_file"

    return 1
  fi

  rm -f "$previous_file" "$backup_file"

  return 0
}

verify_gateway() {
  local new_container="$1"

  echo "⏳ Verifying gateway → $new_container..."

  for i in {1..10}; do

    if docker exec "$NGINX_CONTAINER" \
      curl -fsS \
      --max-time 5 \
      "http://${new_container}:4005/health" \
      >/dev/null 2>&1; then

      echo "✅ Gateway network can reach $new_container"
      return 0
    fi

    echo "Gateway verification: retry $i/10"
    sleep 2
  done

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

  docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true

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

    docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
    cleanup_image

    exit 1
  fi

  ###################################################
  # Health check
  ###################################################

  if ! wait_for_container_health \
    "$APP_CONTAINER" \
    "Staging application"; then

    docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
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
    docker rm -f "$APP_CONTAINER" >/dev/null 2>&1 || true
    cleanup_image

    exit 1
  fi

  ###################################################
  # Success
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

export IMAGE_TAG="${IMAGE##*:}"

#####################################################
# Production database
#####################################################

log "Ensuring production database is healthy"

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

CURRENT_CONTAINER="$(get_active_container)"

echo
echo "Current container : ${CURRENT_CONTAINER:-none}"

#####################################################
# Select inactive color
#####################################################

NEW_CONTAINER="$(get_new_container "$CURRENT_CONTAINER")"

echo "New container     : $NEW_CONTAINER"

#####################################################
# Safety check
#####################################################

if [[ "$CURRENT_CONTAINER" == "$NEW_CONTAINER" ]]; then
  echo "❌ New container is already active"
  exit 1
fi

#####################################################
# Remove inactive container
#####################################################

log "Cleaning inactive deployment"

docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true

#####################################################
# Start new production container
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

  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  cleanup_image

  exit 1
fi

#####################################################
# Health check new container
#####################################################

if ! wait_for_container_health \
  "$NEW_CONTAINER" \
  "New production application"; then

  echo
  echo "❌ New production deployment failed"

  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  cleanup_image

  echo "✅ Existing production container remains untouched"

  exit 1
fi

#####################################################
# Verify Docker network connectivity
#####################################################

log "Verifying production Docker network"

if ! docker exec "$NGINX_CONTAINER" \
  curl -fsS \
  --max-time 10 \
  "http://${NEW_CONTAINER}:4005/health" \
  >/dev/null 2>&1; then

  echo "❌ Gateway cannot reach new production container"

  docker logs --tail 200 "$NEW_CONTAINER" || true
  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  cleanup_image

  echo "✅ Existing production container remains untouched"

  exit 1
fi

echo "✅ Gateway can reach $NEW_CONTAINER"

#####################################################
# Switch Nginx traffic
#####################################################

log "Switching Nginx traffic"

if ! switch_nginx "$NEW_CONTAINER"; then

  echo "❌ Failed to switch Nginx traffic"

  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  cleanup_image

  echo "✅ Existing production container remains untouched"

  exit 1
fi

echo "✅ Nginx traffic switched to $NEW_CONTAINER"

#####################################################
# Verify new container after traffic switch
#####################################################

log "Verifying production deployment"

if ! verify_gateway "$NEW_CONTAINER"; then

  echo "❌ Production verification failed"

  ###################################################
  # Rollback Nginx
  ###################################################

  if [[ -n "$CURRENT_CONTAINER" ]] &&
     container_running "$CURRENT_CONTAINER"; then

    echo "🔄 Rolling traffic back to $CURRENT_CONTAINER"

    if switch_nginx "$CURRENT_CONTAINER"; then
      echo "✅ Traffic rollback completed"
    else
      echo "🚨 CRITICAL: Nginx rollback failed"
      echo "🚨 Manual Nginx recovery may be required"
    fi

  else

    echo "ℹ️ No previous production container available for rollback"

  fi

  docker rm -f "$NEW_CONTAINER" >/dev/null 2>&1 || true
  cleanup_image

  exit 1
fi

#####################################################
# Remove previous production container
#####################################################

if [[ -n "$CURRENT_CONTAINER" ]]; then

  log "Removing previous production container"

  docker rm -f "$CURRENT_CONTAINER" >/dev/null 2>&1 || true

else

  echo "ℹ️ No previous production container"
fi

#####################################################
# Cleanup dangling images
#####################################################

log "Cleaning dangling Docker images"

docker image prune -f >/dev/null 2>&1 || true

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