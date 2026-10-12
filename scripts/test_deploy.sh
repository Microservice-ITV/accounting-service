#!/usr/bin/env bash
# ============================================================
# DEPLOYMENT LOGIC TESTS (blue/green switch + rollback)
# ============================================================
# These tests exercise switch_nginx(), verify_nginx_upstream() and
# production_failure_cleanup() against a MOCK docker command, so the
# blue/green traffic-switch and rollback logic can be validated without a
# running gateway or real containers.
#
# The mock docker simulates:
#   - the gateway container "microservices-gateway"
#   - its active Nginx configuration (nginx -T) loaded from an upstream
#     include file whose path is discovered from the active config
#   - blue/green accounting containers, their health and reachability
#
# Usage:
#   ./scripts/test_deploy.sh
# ============================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

TESTDIR="$(mktemp -d)"
BIN="$TESTDIR/bin"
STATE="$TESTDIR/state"
mkdir -p "$BIN" "$STATE"

cleanup() { rm -rf "$TESTDIR"; }
trap cleanup EXIT

# Upstream include file path as seen INSIDE the gateway container.
UPFILE="/etc/nginx/conf.d/accounting-service-upstream.conf"

# ------------------------------------------------------------
# Mock docker
# ------------------------------------------------------------
cat > "$BIN/docker" <<'MOCK'
#!/usr/bin/env bash
STATE="${MOCK_STATE:?MOCK_STATE not set}"
NGINX="microservices-gateway"
UPFILE="/etc/nginx/conf.d/accounting-service-upstream.conf"

target() { cat "$STATE/nginx_target" 2>/dev/null || echo ""; }

cmd="${1:-}"; shift || true

case "$cmd" in
    container)
        case "${1:-}" in
            inspect)
                name="${2:-}"
                if [[ "$name" == "$NGINX" ]]; then exit 0; fi
                [[ -f "$STATE/${name}_running" ]] && exit 0
                exit 1
                ;;
        esac
        exit 0
        ;;
    inspect)
        # docker inspect --format='...' <name>
        local_fmt=""
        local_name=""
        for a in "$@"; do
            case "$a" in
                --format=*) local_fmt="${a#--format=}" ;;
                -*) : ;;
                *) local_name="$a" ;;
            esac
        done
        fmt="$local_fmt"; name="$local_name"
        case "$fmt" in
            *State.Status*) cat "$STATE/${name}_running" 2>/dev/null || echo "missing" ;;
            *State.Health*) cat "$STATE/${name}_health" 2>/dev/null || echo "none" ;;
            *Config.Image*) cat "$STATE/${name}_image" 2>/dev/null || echo "none" ;;
            *) echo "" ;;
        esac
        exit 0
        ;;
    exec)
        interactive=0
        if [[ "${1:-}" == "-i" ]]; then interactive=1; shift; fi
        cname="${1:-}"; shift
        rest="$*"
        case "$rest" in
            *"nginx -T")
                t="$(target)"
                cat <<EOF
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
# configuration file /etc/nginx/nginx.conf:
worker_processes auto;
# configuration file $UPFILE:
upstream accounting_service_backend {
    server ${t}:4005;
}
EOF
                exit 0
                ;;
            *"nginx -t")
                if [[ "$(cat "$STATE/nginx_t_fail" 2>/dev/null || echo 0)" == "1" ]]; then
                    echo "nginx: [emerg] invalid configuration" >&2
                    exit 1
                fi
                exit 0
                ;;
            *"nginx -s reload")
                if [[ "$(cat "$STATE/reload_fail" 2>/dev/null || echo 0)" == "1" ]]; then
                    echo "nginx: reload failed" >&2
                    exit 1
                fi
                exit 0
                ;;
            *"cat >"*"$UPFILE"*)
                content="$(cat)"
                newtarget="$(printf '%s\n' "$content" \
                    | sed -n 's/.*server[[:space:]]\+\([^:;[:space:]]*\):[0-9]*;.*/\1/p' \
                    | head -n1)"
                echo "$newtarget" > "$STATE/nginx_target"
                exit 0
                ;;
            "cat $UPFILE")
                cat <<EOF
upstream accounting_service_backend {
    server $(target):4005;
}
EOF
                exit 0
                ;;
            curl*)
                url="${!#}"
                host="$(printf '%s' "$url" | sed -n 's#http://\([^:/]*\):.*#\1#p')"
                h="$(cat "$STATE/${host}_health" 2>/dev/null || echo missing)"
                if [[ "$h" == "healthy" ]]; then exit 0; fi
                exit 22
                ;;
        esac
        exit 0
        ;;
    rm)
        name="${@: -1}"
        rm -f "$STATE/${name}_running"
        exit 0
        ;;
    stop)
        name="${@: -1}"
        rm -f "$STATE/${name}_running"
        exit 0
        ;;
    images|image|network|volume|ps|logs|compose|pull|login)
        exit 0
        ;;
esac
exit 0
MOCK
chmod +x "$BIN/docker"

export PATH="$BIN:$PATH"
export MOCK_STATE="$STATE"

reset_state() {
    echo "accounting-service-blue" > "$STATE/nginx_target"
    echo healthy > "$STATE/accounting-service-blue_health"
    echo healthy > "$STATE/accounting-service-green_health"
    echo running > "$STATE/accounting-service-blue_running"
    echo running > "$STATE/accounting-service-green_running"
    echo 0 > "$STATE/nginx_t_fail"
    echo 0 > "$STATE/reload_fail"
    echo "img:blue"  > "$STATE/accounting-service-blue_image"
    echo "img:green" > "$STATE/accounting-service-green_image"
}
reset_state

# ------------------------------------------------------------
# Load the deployment functions (no real deployment runs)
# ------------------------------------------------------------
# shellcheck source=./deploy.sh
source "$REPO_DIR/scripts/deploy.sh" production "itvmicroservicesteam/accounting-service:test" >/dev/null 2>&1

# The deployment script installs strict mode + an ERR trap for real runs.
# Neutralise them so tests can assert on function return codes.
set +e +E +u
trap - ERR

PASS=0
FAIL=0
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [[ "$expected" == "$actual" ]]; then
        echo "  ✅ $desc"
        PASS=$((PASS + 1))
    else
        echo "  ❌ $desc"
        echo "        expected: '$expected'"
        echo "        actual  : '$actual'"
        FAIL=$((FAIL + 1))
    fi
}

BLUE="$BLUE_CONTAINER"
GREEN="$GREEN_CONTAINER"

echo
echo "========================================="
echo "TEST 1: get_active_container reads active Nginx config"
echo "========================================="
reset_state
active="$(get_active_container)"
assert_eq "active container detected from nginx -T" "$BLUE" "$active"

echo
echo "========================================="
echo "TEST 2: successful blue -> green switch"
echo "========================================="
reset_state
path="$(nginx_upstream_file_path)"
assert_eq "upstream file path discovered" "$UPFILE" "$path"

switch_nginx "$GREEN" >/dev/null 2>&1
rc=$?
assert_eq "switch_nginx returns 0" "0" "$rc"
assert_eq "nginx -T now points to green" "$GREEN" "$(cat "$STATE/nginx_target")"

verify_nginx_upstream "$GREEN" >/dev/null 2>&1
rc=$?
assert_eq "verify_nginx_upstream passes for green" "0" "$rc"

echo
echo "========================================="
echo "TEST 3: verification fails when container is unhealthy"
echo "========================================="
reset_state
switch_nginx "$GREEN" >/dev/null 2>&1
echo unhealthy > "$STATE/accounting-service-green_health"
verify_nginx_upstream "$GREEN" >/dev/null 2>&1
rc=$?
assert_eq "verify fails for unhealthy green" "1" "$rc"

echo
echo "========================================="
echo "TEST 4: switch aborts when nginx -t rejects new config"
echo "========================================="
reset_state
echo 1 > "$STATE/nginx_t_fail"
switch_nginx "$GREEN" >/dev/null 2>&1
rc=$?
assert_eq "switch_nginx returns 1 on invalid config" "1" "$rc"
assert_eq "nginx target unchanged (still blue)" "$BLUE" "$(cat "$STATE/nginx_target")"

echo
echo "========================================="
echo "TEST 5: rollback restores blue and removes green"
echo "========================================="
reset_state
# Simulate: traffic was switched to green, then post-switch verification
# (real gateway smoke test) failed.
switch_nginx "$GREEN" >/dev/null 2>&1
CURRENT_CONTAINER="$BLUE"
NEW_CONTAINER="$GREEN"
PRODUCTION_SWITCHED=1
DEPLOYMENT_SUCCESS=0
IMAGE="itvmicroservicesteam/accounting-service:test"

production_failure_cleanup >/dev/null 2>&1
assert_eq "nginx restored to blue" "$BLUE" "$(cat "$STATE/nginx_target")"
verify_nginx_upstream "$BLUE" >/dev/null 2>&1
assert_eq "blue verified healthy after rollback" "0" "$?"
if [[ -f "$STATE/accounting-service-green_running" ]]; then
    assert_eq "green container removed after verified rollback" "removed" "present"
else
    assert_eq "green container removed after verified rollback" "removed" "removed"
fi

echo
echo "========================================="
echo "TEST 6: rollback keeps new container when rollback unverifiable"
echo "========================================="
reset_state
# Previous (blue) container is unhealthy, so rollback verification fails.
echo unhealthy > "$STATE/accounting-service-blue_health"
switch_nginx "$GREEN" >/dev/null 2>&1
CURRENT_CONTAINER="$BLUE"
NEW_CONTAINER="$GREEN"
PRODUCTION_SWITCHED=1
DEPLOYMENT_SUCCESS=0

production_failure_cleanup >/dev/null 2>&1
if [[ -f "$STATE/accounting-service-green_running" ]]; then
    assert_eq "green kept because rollback not verified" "kept" "kept"
else
    assert_eq "green kept because rollback not verified" "kept" "removed"
fi

echo
echo "========================================="
if [[ "$FAIL" -eq 0 ]]; then
    echo "✅ ALL TESTS PASSED ($PASS assertions)"
    echo "========================================="
    exit 0
else
    echo "❌ TESTS FAILED ($FAIL failed, $PASS passed)"
    echo "========================================="
    exit 1
fi