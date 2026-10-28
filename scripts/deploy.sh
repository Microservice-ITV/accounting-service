#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# ACCOUNTING SERVICE DEPLOYMENT
# ============================================================
# Modes:
#   staging    Validate a new image in an isolated environment.
#   production Blue/green deployment with Nginx traffic switch.
#
# Usage:
#   ./deploy.sh staging <image>
#   ./deploy.sh production <image>
#
# Example:
#   ./deploy.sh staging itvmicroservicesteam/accounting-service:abc123
#   ./deploy.sh production itvmicroservicesteam/accounting-service:abc123
# ============================================================

# ============================================================
# ARGUMENTS
# ============================================================
MODE="${1:-}"
IMAGE="${2:-}"

# ============================================================
# PATHS / PROJECTS
# ============================================================
DEPLOY_DIR="/var/www/html/microservices/accounting-service"
GATEWAY_DIR="/var/www/html/microservices/gateway"
GATEWAY_NGINX_DIR="$GATEWAY_DIR/nginx"
COMPOSE_FILE="$DEPLOY_DIR/docker-compose.prod.yml"
NETWORK_NAME="itv-network"
NGINX_CONTAINER="microservices-gateway"
NGINX_UPSTREAM_FILE="$GATEWAY_NGINX_DIR/accounting-service-upstream.conf"
NGINX_UPSTREAM_BLOCK="accounting_service_backend"
NGINX_UPSTREAM_PORT="4005"
STAGING_PROJECT="accounting-staging"
PRODUCTION_PROJECT="accounting-service-prod"
LOCK_FILE="/tmp/accounting-service-deploy.lock"

# ============================================================
# STAGING
# ============================================================
STAGING_APP_CONTAINER="accounting-service-staging"
STAGING_DB_CONTAINER="accounting-db-staging"
STAGING_VOLUME="accounting-postgres-staging-data"
STAGING_HOST_PORT="14005"

# ============================================================
# PRODUCTION BLUE / GREEN
# ============================================================
BLUE_CONTAINER="accounting-service-blue"
GREEN_CONTAINER="accounting-service-green"
LEGACY_CONTAINER="accounting-service"

# ============================================================
# HEALTH / RETRIES
# ============================================================
HEALTH_PATH="/health"
HEALTH_PORT="4005"
HEALTH_RETRIES=30
HEALTH_INTERVAL=2
DB_RETRIES=30
DB_INTERVAL=2
PULL_TIMEOUT_SECONDS="${PULL_TIMEOUT_SECONDS:-300}"
GATEWAY_RETRIES=10
GATEWAY_INTERVAL=2

# ============================================================
# GRACEFUL SHUTDOWN
# ============================================================
DRAIN_SECONDS=20
OLD_CONTAINER_STOP_TIMEOUT=30

# ============================================================
# PRODUCTION SMOKE TEST
# ============================================================
PRODUCTION_SMOKE_TEST_URL="${PRODUCTION_SMOKE_TEST_URL:-}"

# ============================================================
# DEPLOYMENT STATE
# ============================================================
CURRENT_CONTAINER=""
NEW_CONTAINER=""
PREVIOUS_PRODUCTION_IMAGE=""
PRODUCTION_SWITCHED=0
DEPLOYMENT_SUCCESS=0
FAILURE_CLEANUP_RUNNING=0

# ============================================================
# MODE VALIDATION
# ============================================================
case "$MODE" in
    staging)
        ENV_FILE="$DEPLOY_DIR/.env.staging"
        APP_CONTAINER="$STAGING_APP_CONTAINER"
        DB_CONTAINER="$STAGING_DB_CONTAINER"
        APP_PORT="$STAGING_HOST_PORT"
        ;;
    production)
        ENV_FILE="$DEPLOY_DIR/.env.prod"
        DB_CONTAINER="accounting-db"
        APP_PORT="$HEALTH_PORT"
        ;;
    *)
        echo "❌ Invalid deployment mode."
        echo
        echo "Usage:"
        echo "  $0 staging <image>"
        echo "  $0 production <image>"
        exit 1
        ;;
esac

if [[ -z "$IMAGE" ]]; then
    echo "❌ Docker image is required."
    echo
    echo "Usage:"
    echo "  $0 $MODE <image>"
    exit 1
fi

# ============================================================
# IMAGE VALIDATION
# ============================================================
IMAGE_REPOSITORY="${IMAGE%:*}"

if [[ "$IMAGE_REPOSITORY" == "$IMAGE" ]]; then
    echo "❌ Docker image must contain an explicit tag:"
    echo "   $IMAGE"
    exit 1
fi

# ============================================================
# LOGGING
# ============================================================
log() { echo; echo "▶ $1"; }
success() { echo "✅ $1"; }
warning() { echo "⚠️ $1"; }
error() { echo "❌ $1"; }

# ============================================================
# PRE-FLIGHT VALIDATION
# ============================================================
validate_environment() {
    if [[ ! -f "$ENV_FILE" ]]; then
        error "Environment file not found:"
        echo "   $ENV_FILE"
        return 1
    fi

    if [[ ! -f "$COMPOSE_FILE" ]]; then
        error "Compose file not found:"
        echo "   $COMPOSE_FILE"
        return 1
    fi

    if ! command -v docker >/dev/null 2>&1; then
        error "Docker is not installed or unavailable."
        return 1
    fi

    if ! command -v flock >/dev/null 2>&1; then
        error "flock is required."
        return 1
    fi

    if ! command -v timeout >/dev/null 2>&1; then
        error "GNU timeout (coreutils) is required to bound image pulls."
        return 1
    fi

    if [[ ! "$PULL_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]]; then
        error "PULL_TIMEOUT_SECONDS must be a positive integer."
        return 1
    fi

    if [[ "$MODE" == "staging" ]]; then
        if ! command -v curl >/dev/null 2>&1; then
            error "curl is required for staging."
            return 1
        fi
        return 0
    fi

    if ! docker container inspect "$NGINX_CONTAINER" >/dev/null 2>&1; then
        error "Gateway container not found:"
        echo "   $NGINX_CONTAINER"
        return 1
    fi

    if ! docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
        error "Gateway Nginx configuration is not loadable inside $NGINX_CONTAINER."
        return 1
    fi

    if [[ -z "$(nginx_dump_config | extract_upstream_target)" ]]; then
        error "Gateway has no resolvable accounting upstream."
        echo "   Expected an 'upstream accounting_service_backend' block in $NGINX_CONTAINER."
        return 1
    fi

    if [[ -z "$PRODUCTION_SMOKE_TEST_URL" ]]; then
        error "PRODUCTION_SMOKE_TEST_URL is required."
        echo "   It must point to a safe read-only endpoint through the gateway."
        return 1
    fi

    if ! docker exec "$NGINX_CONTAINER" sh -c 'command -v curl >/dev/null 2>&1'; then
        error "curl is required inside $NGINX_CONTAINER."
        return 1
    fi

    return 0
}

# ============================================================
# DEPLOYMENT LOCK
# ============================================================
acquire_deployment_lock() {
    exec 9>"$LOCK_FILE"

    if ! flock -n 9; then
        error "Another Accounting Service deployment is already running."
        return 1
    fi

    echo "🔒 Deployment lock acquired."
}

# ============================================================
# CONTAINER HELPERS
# ============================================================
container_exists() { docker container inspect "$1" >/dev/null 2>&1; }

container_running() {
    [[ "$(docker inspect --format='{{.State.Status}}' "$1" 2>/dev/null || true)" == "running" ]]
}

container_health() {
    docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$1" 2>/dev/null || echo "missing"
}

get_container_image() {
    docker inspect --format='{{.Config.Image}}' "$1" 2>/dev/null || true
}

remove_container() {
    local container="$1"

    if ! container_exists "$container"; then
        return 0
    fi

    echo "🗑️ Removing container: $container"
    docker rm -f "$container" >/dev/null 2>&1 || true
}

stop_container_gracefully() {
    local container="$1"

    if ! container_exists "$container"; then
        return 0
    fi

    if ! container_running "$container"; then
        docker rm "$container" >/dev/null 2>&1 || true
        return 0
    fi

    echo "⏳ Gracefully stopping $container (${OLD_CONTAINER_STOP_TIMEOUT}s)..."

    if docker stop --time "$OLD_CONTAINER_STOP_TIMEOUT" "$container" >/dev/null 2>&1; then
        docker rm "$container" >/dev/null 2>&1 || true
        success "$container stopped gracefully."
        return 0
    fi

    warning "Graceful stop timed out."
    warning "Forcing removal of $container."
    docker rm -f "$container" >/dev/null 2>&1 || true
}

# ============================================================
# IMAGE HELPERS
# ============================================================
image_referenced_by_container() {
    local image="$1"
    docker ps -a --format '{{.Image}}' | grep -Fxq "$image"
}

remove_deployment_image_if_unused() {
    local image="$1"
    [[ -z "$image" ]] && return 0

    if image_referenced_by_container "$image"; then
        echo "ℹ️ Keeping image because a container still references it:"
        echo "   $image"
        return 0
    fi

    echo "🧹 Removing unused deployment image:"
    echo "   $image"
    docker image rm "$image" >/dev/null 2>&1 || true
}

# ============================================================
# STAGING CLEANUP
# ============================================================
cleanup_staging() {
    echo
    echo "🧹 Cleaning temporary staging environment..."

    remove_container "$STAGING_APP_CONTAINER"

    docker compose -p "$STAGING_PROJECT" --env-file "$DEPLOY_DIR/.env.staging" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true

    docker volume rm "$STAGING_VOLUME" >/dev/null 2>&1 || true

    success "Temporary staging environment removed."
}

# ============================================================
# DATABASE HEALTH
# ============================================================
wait_for_db() {
    local container="$1"

    echo "⏳ Waiting for database..."

    for i in $(seq 1 "$DB_RETRIES"); do
        if ! container_exists "$container"; then
            echo "Database container not created yet... ($i/$DB_RETRIES)"
            sleep "$DB_INTERVAL"
            continue
        fi

        local status
        status="$(docker inspect --format='{{.State.Health.Status}}' "$container" 2>/dev/null || echo "starting")"

        case "$status" in
            healthy)
                success "Database healthy."
                return 0
                ;;
            unhealthy)
                error "Database is unhealthy."
                docker logs --tail 150 "$container" || true
                return 1
                ;;
            *)
                echo "Database: $status ($i/$DB_RETRIES)"
                sleep "$DB_INTERVAL"
                ;;
        esac
    done

    error "Database failed health check."
    docker logs --tail 150 "$container" || true
    return 1
}

# ============================================================
# APPLICATION HEALTH
# ============================================================
wait_for_container_health() {
    local container="$1"
    local label="$2"

    echo "⏳ Waiting for $label..."

    for i in $(seq 1 "$HEALTH_RETRIES"); do
        if ! container_exists "$container"; then
            echo "Container not created yet... ($i/$HEALTH_RETRIES)"
            sleep "$HEALTH_INTERVAL"
            continue
        fi

        local status
        local health

        status="$(docker inspect --format='{{.State.Status}}' "$container" 2>/dev/null || echo "missing")"
        health="$(container_health "$container")"

        if [[ "$status" == "exited" || "$status" == "dead" ]]; then
            error "$label container exited."
            docker logs --tail 200 "$container" || true
            return 1
        fi

        if [[ "$status" != "running" ]]; then
            echo "$label: $status ($i/$HEALTH_RETRIES)"
            sleep "$HEALTH_INTERVAL"
            continue
        fi

        if [[ "$health" == "healthy" ]]; then
            success "$label healthy."
            return 0
        fi

        if [[ "$health" == "unhealthy" ]]; then
            error "$label Docker healthcheck failed."
            docker logs --tail 200 "$container" || true
            return 1
        fi

        echo "$label: health=$health ($i/$HEALTH_RETRIES)"
        sleep "$HEALTH_INTERVAL"
    done

    error "$label health check timed out."
    docker logs --tail 200 "$container" || true
    return 1
}

# ============================================================
# PRODUCTION ACTIVE CONTAINER
# ============================================================
get_active_container() {
    local active=""

    active="$(nginx_dump_config | extract_upstream_target || true)"

    if [[ -z "$active" ]]; then
        error "Unable to determine active production container from Nginx active configuration."
        echo "   Expected an 'upstream $NGINX_UPSTREAM_BLOCK' block in $NGINX_CONTAINER."
        return 1
    fi

    case "$active" in
        "$BLUE_CONTAINER"|"$GREEN_CONTAINER"|"$LEGACY_CONTAINER") ;;
        *)
            error "Nginx upstream points to an unexpected container:"
            echo "   $active"
            return 1
            ;;
    esac

    if ! container_running "$active"; then
        error "Nginx says '$active' is active, but it is not running."
        return 1
    fi

    echo "$active"
}

get_new_container() {
    local current="$1"

    case "$current" in
        "$BLUE_CONTAINER") echo "$GREEN_CONTAINER" ;;
        "$GREEN_CONTAINER") echo "$BLUE_CONTAINER" ;;
        "$LEGACY_CONTAINER") echo "$BLUE_CONTAINER" ;;
        *)
            error "Cannot determine new production color."
            return 1
            ;;
    esac
}

# ============================================================
# NGINX ACTIVE CONFIGURATION (SOURCE OF TRUTH)
# ============================================================
# The gateway runs in a separate container ("microservices-gateway")
# whose Nginx loads the accounting upstream from a mounted include
# file. The authoritative view of what Nginx actually serves is its
# active configuration (nginx -T), NOT a host-side file that may or may
# not be mounted. Every read/write below therefore goes through the
# container, so the file we edit is exactly the file Nginx loads.

# Dump the full active Nginx configuration from the gateway container.
nginx_dump_config() {
    docker exec "$NGINX_CONTAINER" nginx -T 2>/dev/null
}

# Parse Nginx configuration text and print the server target (host part
# only) declared inside the accounting upstream block.
extract_upstream_target() {
    awk -v block="$NGINX_UPSTREAM_BLOCK" '
        $0 ~ ("upstream[[:space:]]+" block) { inblk = 1; next }
        inblk && /}/ { inblk = 0; next }
        inblk {
            if (match($0, /server[[:space:]]+[^;[:space:]]+:[0-9]+/)) {
                target = substr($0, RSTART, RLENGTH)
                sub(/^server[[:space:]]+/, "", target)
                sub(/:[0-9]+$/, "", target)
                print target
                exit
            }
        }
    '
}

# Determine the exact file path (inside the container) that Nginx loads
# the accounting upstream from, based on the active configuration.
nginx_upstream_file_path() {
    local config
    config="$(nginx_dump_config)" || return 1

    printf '%s\n' "$config" | awk -v block="$NGINX_UPSTREAM_BLOCK" '
        /^# configuration file / { path = $4; sub(/:$/, "", path); next }
        $0 ~ ("upstream[[:space:]]+" block) { print path; found = 1; exit }
        END { if (!found) exit 1 }
    '
}

# Render the upstream include file content for the given container.
render_upstream_file() {
    local container="$1"

    cat <<EOF
upstream ${NGINX_UPSTREAM_BLOCK} {
    server ${container}:${NGINX_UPSTREAM_PORT};
}
EOF
}

write_upstream_file() {
    local container="$1"
    local target_file="$2"

    render_upstream_file "$container" > "$target_file"
}

# Read the current content of the Nginx-loaded upstream file into a
# backup file on the host.
nginx_upstream_file_backup() {
    local target_file="$1"
    local backup_file="$2"

    docker exec "$NGINX_CONTAINER" cat "$target_file" > "$backup_file" 2>/dev/null || : > "$backup_file"
}

# Write host file content into the Nginx-loaded upstream file inside the
# container.
nginx_upstream_file_restore() {
    local target_file="$1"
    local source_file="$2"

    docker exec -i "$NGINX_CONTAINER" sh -c "cat > '$target_file'" < "$source_file"
}

switch_nginx() {
    local new_container="$1"
    local target_file
    local previous_file
    local temporary_file

    # Discover the exact file Nginx actually loads the upstream from.
    # Writing to any other path would leave the running gateway unchanged.
    if ! target_file="$(nginx_upstream_file_path)"; then
        error "Unable to locate the accounting upstream file inside $NGINX_CONTAINER."
        echo "   Expected an 'upstream $NGINX_UPSTREAM_BLOCK' block in the active configuration."
        return 1
    fi

    echo "ℹ️ Nginx loads accounting upstream from: $target_file"

    previous_file="$(mktemp)"
    temporary_file="$(mktemp)"

    cleanup_switch_files() {
        rm -f "$previous_file" "$temporary_file"
    }

    # Backup the currently loaded upstream file content.
    nginx_upstream_file_backup "$target_file" "$previous_file"

    # Write the new upstream into the file Nginx actually loads.
    write_upstream_file "$new_container" "$temporary_file"

    if ! nginx_upstream_file_restore "$target_file" "$temporary_file"; then
        error "Failed to write upstream file inside $NGINX_CONTAINER: $target_file"

        if [[ -s "$previous_file" ]]; then
            nginx_upstream_file_restore "$target_file" "$previous_file" || true
        fi

        cleanup_switch_files
        return 1
    fi

    # Validate the new configuration before reloading.
    if ! docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
        error "Nginx configuration validation failed."

        if [[ -s "$previous_file" ]]; then
            nginx_upstream_file_restore "$target_file" "$previous_file" || true
        fi

        if docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
            docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true
        fi

        cleanup_switch_files
        return 1
    fi

    # Reload Nginx to apply the new upstream.
    if ! docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1; then
        error "Nginx reload failed."

        if [[ -s "$previous_file" ]]; then
            nginx_upstream_file_restore "$target_file" "$previous_file" || true
        fi

        if docker exec "$NGINX_CONTAINER" nginx -t >/dev/null 2>&1; then
            docker exec "$NGINX_CONTAINER" nginx -s reload >/dev/null 2>&1 || true
        fi

        cleanup_switch_files
        return 1
    fi

    cleanup_switch_files
    success "Nginx reloaded; accounting upstream switched to $new_container."
    return 0
}

# ============================================================
# VERIFY NGINX UPSTREAM
# ============================================================
# Verification is based on the gateway's ACTIVE configuration
# (nginx -T) plus the health and reachability of the expected
# container. This is the same source of truth used by switch_nginx,
# so a successful switch is guaranteed to be observed here.
verify_nginx_upstream() {
    local expected_container="$1"
    local nginx_config=""
    local actual_container=""

    # Capture the full active Nginx configuration before searching it.
    # This avoids grep -q closing the pipe early when pipefail is enabled.
    if ! nginx_config="$(nginx_dump_config)"; then
        error "Failed to read active Nginx configuration from $NGINX_CONTAINER."
        return 1
    fi

    # Extract the upstream target Nginx is actually serving from the
    # active configuration (not from any host-side file).
    actual_container="$(printf '%s\n' "$nginx_config" | extract_upstream_target || true)"

    if [[ "$actual_container" != "$expected_container" ]]; then
        error "Nginx upstream verification failed."
        echo "   Expected: $expected_container"
        echo "   Actual  : ${actual_container:-none}"
        echo "Active accounting upstream configuration:"
        grep -A3 -B1 "upstream ${NGINX_UPSTREAM_BLOCK}" <<< "$nginx_config" || true
        return 1
    fi

    # Confirm the exact upstream directive is present.
    if ! grep -Fq -- "server ${expected_container}:${NGINX_UPSTREAM_PORT};" <<< "$nginx_config"; then
        error "Gateway active configuration is missing the expected upstream directive:"
        echo "   server ${expected_container}:${NGINX_UPSTREAM_PORT};"
        return 1
    fi

    # Confirm the expected container is healthy.
    if [[ "$(container_health "$expected_container")" != "healthy" ]]; then
        error "Expected upstream container is not healthy: $expected_container"
        return 1
    fi

    # Confirm the gateway can actually reach the expected container.
    if ! docker exec "$NGINX_CONTAINER" curl -fsS --max-time 10 \
            "http://${expected_container}:${NGINX_UPSTREAM_PORT}${HEALTH_PATH}" >/dev/null 2>&1; then
        error "Gateway cannot reach expected upstream container:"
        echo "   http://${expected_container}:${NGINX_UPSTREAM_PORT}${HEALTH_PATH}"
        return 1
    fi

    success "Nginx upstream verified: ${expected_container}:${NGINX_UPSTREAM_PORT} (healthy and reachable)."
    return 0
}

# ============================================================
# REAL GATEWAY SMOKE TEST
# ============================================================
verify_gateway_traffic() {
    local expected_container="$1"

    echo "⏳ Verifying Nginx traffic → $expected_container..."

    if ! verify_nginx_upstream "$expected_container"; then
        return 1
    fi

    for i in $(seq 1 "$GATEWAY_RETRIES"); do
        if docker exec "$NGINX_CONTAINER" curl -fsS --max-time 10 "$PRODUCTION_SMOKE_TEST_URL" >/dev/null 2>&1; then
            success "Real gateway smoke test passed."
            return 0
        fi

        echo "Gateway smoke test retry $i/$GATEWAY_RETRIES"
        sleep "$GATEWAY_INTERVAL"
    done

    error "Real gateway smoke test failed:"
    echo "   $PRODUCTION_SMOKE_TEST_URL"
    return 1
}

# ============================================================
# PRODUCTION IMAGE CLEANUP
# ============================================================
cleanup_old_accounting_images() {
    local previous_image="${1:-}"
    local active_image=""
    local current_image="$IMAGE"
    local image=""
    local images=""

    echo "🧹 Cleaning old Accounting Service images..."

    if [[ -n "$NEW_CONTAINER" ]] && container_running "$NEW_CONTAINER"; then
        active_image="$(get_container_image "$NEW_CONTAINER")"
    fi

    echo
    echo "Protected images:"
    [[ -n "$active_image" ]] && echo "  Current  : $active_image"
    [[ -n "$previous_image" ]] && echo "  Previous : $previous_image"
    echo "  Deploying: $current_image"

    images="$(docker images "$IMAGE_REPOSITORY" --format '{{.Repository}}:{{.Tag}}' | grep -v '<none>' || true)"

    while IFS= read -r image; do
        [[ -z "$image" ]] && continue
        [[ "$image" == "$current_image" ]] && continue

        if [[ -n "$active_image" && "$image" == "$active_image" ]]; then
            continue
        fi

        if [[ -n "$previous_image" && "$image" == "$previous_image" ]]; then
            continue
        fi

        if image_referenced_by_container "$image"; then
            echo "Keeping referenced image: $image"
            continue
        fi

        echo "Removing old unused image: $image"
        docker image rm "$image" >/dev/null 2>&1 || true
    done <<< "$images"

    docker image prune -f >/dev/null 2>&1 || true
    success "Old unused Accounting Service images cleaned."
}

# ============================================================
# PRODUCTION FAILURE CLEANUP
# ============================================================
production_failure_cleanup() {
    local exit_code="${1:-1}"
    local rollback_verified=0

    if [[ "$FAILURE_CLEANUP_RUNNING" -eq 1 ]]; then
        return 0
    fi

    FAILURE_CLEANUP_RUNNING=1

    echo
    echo "========================================="
    echo "⚠️ PRODUCTION DEPLOYMENT FAILED"
    echo "========================================="

    if [[ "$PRODUCTION_SWITCHED" -eq 1 ]]; then
        if [[ -n "$CURRENT_CONTAINER" ]] && container_running "$CURRENT_CONTAINER"; then
            echo "🔄 Restoring traffic to:"
            echo "   $CURRENT_CONTAINER"

            if switch_nginx "$CURRENT_CONTAINER"; then
                if verify_nginx_upstream "$CURRENT_CONTAINER"; then
                    PRODUCTION_SWITCHED=0
                    rollback_verified=1
                    success "Production traffic restored."
                else
                    error "CRITICAL: Nginx rollback verification failed."
                    error "Manual intervention may be required."
                fi
            else
                error "CRITICAL: Nginx rollback failed."
                error "Manual intervention may be required."
            fi
        else
            error "Previous production container is unavailable."
            error "Automatic traffic rollback is not possible."
        fi
    else
        # Traffic was never switched to the new container, so there is
        # nothing to roll back and removing the new container is safe.
        rollback_verified=1
    fi

    # Only remove the new container once the previously healthy production
    # service is confirmed to be serving traffic again (or was never
    # switched). Never remove a container while Nginx may still point to
    # it, otherwise we would tear down the working service.
    if [[ -n "$NEW_CONTAINER" ]] && [[ "$NEW_CONTAINER" != "$CURRENT_CONTAINER" ]]; then
        if [[ "$rollback_verified" -eq 1 ]]; then
            remove_container "$NEW_CONTAINER"
        else
            warning "Keeping $NEW_CONTAINER because rollback could not be verified."
            warning "Remove it manually only after confirming $NGINX_CONTAINER serves ${CURRENT_CONTAINER:-the previous container}."
        fi
    fi

    cleanup_staging
    remove_deployment_image_if_unused "$IMAGE"

    echo
    echo "Failure cleanup completed."
    echo "========================================="

    return 0
}

# ============================================================
# UNEXPECTED ERROR HANDLER
# ============================================================
on_unexpected_error() {
    local exit_code="$1"

    if [[ "$MODE" == "production" ]] && [[ "$DEPLOYMENT_SUCCESS" -eq 0 ]]; then
        production_failure_cleanup "$exit_code"
    fi

    exit "$exit_code"
}

trap 'on_unexpected_error "$?"' ERR

# ============================================================
# DOCKER AUTHENTICATION
# ============================================================
docker_authenticate() {
    log "Docker authentication"

    if [[ -n "${DOCKER_USERNAME:-}" ]] && [[ -n "${DOCKER_TOKEN:-}" ]]; then
        printf '%s' "$DOCKER_TOKEN" | docker login --username "$DOCKER_USERNAME" --password-stdin
        success "Docker authentication completed."
    else
        echo "ℹ️ Docker credentials were not provided."
        echo "   Assuming the image is publicly accessible or already authenticated."
    fi
}

# ============================================================
# PULL IMAGE
# ============================================================
pull_image() {
    log "Pulling Docker image"
    local started_at=$SECONDS
    local pull_status=0
    echo "Started: $(date -u '+%Y-%m-%dT%H:%M:%SZ'); timeout: ${PULL_TIMEOUT_SECONDS}s"

    timeout --foreground --kill-after=10s "${PULL_TIMEOUT_SECONDS}s" docker pull "$IMAGE" || pull_status=$?
    if [[ "$pull_status" -ne 0 ]]; then
        error "Image pull failed after $((SECONDS - started_at))s (exit $pull_status)."
        if [[ "$pull_status" -eq 124 || "$pull_status" -eq 137 ]]; then
            error "Image pull exceeded the ${PULL_TIMEOUT_SECONDS}s deadline."
            echo "   Check VPS registry connectivity, free disk space, and Docker daemon logs."
        fi
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    export IMAGE_TAG="${IMAGE##*:}"

    echo
    echo "Image:"
    echo "  $IMAGE"
    success "Docker image pulled successfully in $((SECONDS - started_at))s."
}

# ============================================================
# STAGING APPLICATION
# ============================================================
start_staging_application() {
    log "Starting staging application"

    docker run -d \
        --name "$APP_CONTAINER" \
        --restart=no \
        --init \
        --env-file "$ENV_FILE" \
        --network "$NETWORK_NAME" \
        -p "127.0.0.1:${APP_PORT}:4005" \
        --read-only \
        --tmpfs "/tmp:rw,nosuid,nodev,size=64m" \
        --security-opt no-new-privileges:true \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        --health-cmd='node -e "require(\"http\").get(\"http://127.0.0.1:4005/health\",r=>process.exit(r.statusCode===200?0:1)).on(\"error\",()=>process.exit(1))"' \
        --health-interval=30s \
        --health-timeout=10s \
        --health-retries=3 \
        --health-start-period=40s \
        "$IMAGE"
}

# ============================================================
# STAGING DEPLOYMENT
# ============================================================
deploy_staging() {
    echo
    echo "========================================="
    echo "🧪 TEMPORARY STAGING DEPLOYMENT"
    echo "========================================="

    cleanup_staging

    log "Starting staging database"

    docker compose -p "$STAGING_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d accounting-db

    if ! wait_for_db "$DB_CONTAINER"; then
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    if ! start_staging_application; then
        error "Failed to start staging application."
        docker logs --tail 200 "$APP_CONTAINER" || true
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    if ! wait_for_container_health "$APP_CONTAINER" "Staging application"; then
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    log "Running staging HTTP smoke test"

    local http_status

    http_status="$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "http://127.0.0.1:${APP_PORT}${HEALTH_PATH}" || true)"

    if [[ "$http_status" != "200" ]]; then
        error "Staging smoke test failed."
        echo "   HTTP status: $http_status"
        docker logs --tail 200 "$APP_CONTAINER" || true
        cleanup_staging
        remove_deployment_image_if_unused "$IMAGE"
        return 1
    fi

    echo
    echo "========================================="
    echo "✅ STAGING VALIDATION PASSED"
    echo "========================================="
    echo
    echo "ℹ️ Staging remains alive for production deployment."
    echo

    return 0
}

# ============================================================
# PRODUCTION DATABASE
# ============================================================
ensure_production_database() {
    log "Ensuring production database is healthy"

    docker compose -p "$PRODUCTION_PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d accounting-db
    wait_for_db "$DB_CONTAINER"
}

# ============================================================
# START PRODUCTION APPLICATION
# ============================================================
start_production_application() {
    log "Starting new production container"

    docker run -d \
        --name "$NEW_CONTAINER" \
        --restart=unless-stopped \
        --init \
        --env-file "$ENV_FILE" \
        --network "$NETWORK_NAME" \
        --read-only \
        --tmpfs "/tmp:rw,nosuid,nodev,size=64m" \
        --security-opt no-new-privileges:true \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        --health-cmd='node -e "require(\"http\").get(\"http://127.0.0.1:4005/health\",r=>process.exit(r.statusCode===200?0:1)).on(\"error\",()=>process.exit(1))"' \
        --health-interval=30s \
        --health-timeout=10s \
        --health-retries=3 \
        --health-start-period=40s \
        "$IMAGE"
}

# ============================================================
# VERIFY GATEWAY NETWORK CONNECTIVITY
# ============================================================
verify_gateway_network_connectivity() {
    log "Validating new container from gateway network"

    if ! docker exec "$NGINX_CONTAINER" curl -fsS --max-time 10 "http://${NEW_CONTAINER}:4005${HEALTH_PATH}" >/dev/null 2>&1; then
        error "Gateway network cannot reach new production container."
        docker logs --tail 200 "$NEW_CONTAINER" || true
        return 1
    fi

    success "Gateway network can reach $NEW_CONTAINER."
}

# ============================================================
# PRODUCTION DEPLOYMENT
# ============================================================
deploy_production() {
    echo
    echo "========================================="
    echo "🚀 ZERO-DOWNTIME PRODUCTION DEPLOYMENT"
    echo "========================================="

    log "Validating production Docker network"

    if ! docker network inspect "$NETWORK_NAME" >/dev/null 2>&1; then
        error "Docker network does not exist:"
        echo "   $NETWORK_NAME"
        return 1
    fi

    ensure_production_database

    log "Determining active production container"

    CURRENT_CONTAINER="$(get_active_container)"

    echo
    echo "Current container:"
    echo "  $CURRENT_CONTAINER"

    NEW_CONTAINER="$(get_new_container "$CURRENT_CONTAINER")"

    echo "New container:"
    echo "  $NEW_CONTAINER"

    if [[ "$CURRENT_CONTAINER" == "$NEW_CONTAINER" ]]; then
        error "New container is already active."
        return 1
    fi

    PREVIOUS_PRODUCTION_IMAGE="$(get_container_image "$CURRENT_CONTAINER")"

    echo
    echo "Previous production image:"
    echo "  ${PREVIOUS_PRODUCTION_IMAGE:-none}"

    log "Cleaning inactive production color"
    remove_container "$NEW_CONTAINER"

    if ! start_production_application; then
        error "Failed to start new production container."
        docker logs --tail 200 "$NEW_CONTAINER" || true
        return 1
    fi

    if ! wait_for_container_health "$NEW_CONTAINER" "New production application"; then
        error "New production deployment failed."
        return 1
    fi

    verify_gateway_network_connectivity

    log "Switching Nginx traffic"

    if ! switch_nginx "$NEW_CONTAINER"; then
        error "Failed to switch Nginx traffic."
        return 1
    fi

    PRODUCTION_SWITCHED=1

    echo
    success "Nginx traffic switched to:"
    echo "   $NEW_CONTAINER"

    log "Running real gateway smoke test"

    if ! verify_gateway_traffic "$NEW_CONTAINER"; then
        error "Production gateway verification failed."
        docker logs --tail 200 "$NEW_CONTAINER" || true
        return 1
    fi

    success "Production gateway verification passed."

    if [[ -n "$CURRENT_CONTAINER" ]]; then
        log "Draining previous production container"
        echo "⏳ Waiting ${DRAIN_SECONDS}s for active connections..."
        sleep "$DRAIN_SECONDS"

        log "Gracefully removing previous production container"
        stop_container_gracefully "$CURRENT_CONTAINER"
    else
        echo "ℹ️ No previous production container."
    fi

    DEPLOYMENT_SUCCESS=1

    log "Removing temporary staging environment"
    cleanup_staging

    log "Cleaning old Accounting Service images"
    cleanup_old_accounting_images "$PREVIOUS_PRODUCTION_IMAGE"

    echo
    echo "📊 Accounting containers:"

    docker ps --filter "name=accounting-service-" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}" || true

    echo
    echo "========================================="
    echo "✅ ZERO-DOWNTIME DEPLOYMENT SUCCESSFUL"
    echo "========================================="

    echo "Active container : $NEW_CONTAINER"
    echo "Image            : $IMAGE"
    echo "Previous image   : ${PREVIOUS_PRODUCTION_IMAGE:-none}"
    echo "Staging          : removed"

    echo "========================================="
}

# ============================================================
# MAIN
# ============================================================
main() {
    validate_environment
    cd "$DEPLOY_DIR"
    acquire_deployment_lock
    docker_authenticate
    pull_image

    case "$MODE" in
        staging)
            deploy_staging
            ;;
        production)
            deploy_production
            ;;
    esac
}

# Only run main when executed directly. When the script is sourced (e.g.
# by the deployment tests), the functions become available for testing
# without performing any real deployment work.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi
