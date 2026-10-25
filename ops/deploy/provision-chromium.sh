#!/bin/bash
# Owner-operated, idempotent Chromium runtime provisioning for the Doodle backend.
# Usage: provision-chromium.sh <backend-dir-with-node_modules>   (a checkout after `npm ci`, or /srv/doodle/current/backend)
# Installs: system libraries, pinned Chromium under /opt/doodle/browsers and the systemd units.
# Never restarts the application.
set -euo pipefail
[[ $(id -u) == 0 ]]
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
backend=$(cd -- "${1:?backend directory required}" && pwd)
cli="$backend/node_modules/playwright-core/cli.js"
node=/opt/doodle/node/bin/node
[[ -f $cli && -x $node ]]
[[ $(uname -m) == x86_64 && $(. /etc/os-release && echo "$VERSION_ID") == 24.04 ]]
version=$("$node" "$cli" --version)
echo "Provisioning Chromium for $version"
export PLAYWRIGHT_BROWSERS_PATH=/opt/doodle/browsers PLAYWRIGHT_SKIP_BROWSER_GC=1
# Shared libraries only (additive apt packages); no removal, no upgrade of unrelated packages.
"$node" "$cli" install-deps chromium
install -d -o root -g root -m 0755 "$PLAYWRIGHT_BROWSERS_PATH"
"$node" "$cli" install chromium
chmod -R go-w,a+rX "$PLAYWRIGHT_BROWSERS_PATH"
# The Chromium OS sandbox needs unprivileged user namespaces; refuse rather than fall back to --no-sandbox.
[[ $(sysctl -n kernel.unprivileged_userns_clone 2>/dev/null || echo 1) == 1 && $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0) == 0 ]] || {
  echo 'Unprivileged user namespaces are restricted; Chromium sandbox unavailable. Add a scoped AppArmor userns profile first.' >&2
  exit 1
}
install -o root -g root -m 0644 "$source_dir/doodle-backend.service" /etc/systemd/system/doodle-backend.service
install -o root -g root -m 0644 "$source_dir/doodle-chromium-smoke.service" /etc/systemd/system/doodle-chromium-smoke.service
systemctl daemon-reload
echo 'Chromium runtime provisioned; running application not restarted (new limits apply on next restart).'
