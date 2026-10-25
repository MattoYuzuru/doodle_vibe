#!/bin/bash
# One-time owner-operated provisioning; never callable by the CI identity.
set -euo pipefail
[[ $(id -u) == 0 ]]
source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
[[ -f "$source_dir/deploy-key.pub" ]]
[[ ! -e /etc/doodle/backend.env ]]
for account in doodle doodle-deploy; do
  if getent passwd "$account" >/dev/null; then
    echo "Refusing existing account: $account" >&2
    exit 1
  fi
done
[[ ! -e /srv/doodle && ! -e /opt/doodle ]]
install -d -o root -g root -m 0755 /opt/doodle /srv/doodle /srv/doodle/releases /etc/doodle
archive=$(mktemp /opt/doodle/node.XXXXXXXX.tar.xz)
trap 'rm -f "$archive"' EXIT
curl -fsSL --connect-timeout 15 --max-time 120 \
  https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz -o "$archive"
printf '%s  %s\n' fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 "$archive" | sha256sum -c -
tar -xJf "$archive" --directory /opt/doodle
ln -s node-v24.21.0-linux-x64 /opt/doodle/node
/opt/doodle/node/bin/node --version
useradd --system --home-dir /var/lib/doodle --shell /usr/sbin/nologin doodle
useradd --system --create-home --home-dir /var/lib/doodle-deploy --shell /bin/sh doodle-deploy
install -d -o doodle -g doodle -m 0700 /var/lib/doodle
install -d -o root -g root -m 0755 /var/lib/doodle-deploy
install -d -o root -g root -m 0755 /var/lib/doodle-deploy/.ssh
{ printf 'restrict,command="/usr/local/libexec/doodle-forced-entry" '; cat "$source_dir/deploy-key.pub"; } > /var/lib/doodle-deploy/.ssh/authorized_keys
chmod 0644 /var/lib/doodle-deploy/.ssh/authorized_keys
install -d -o root -g root -m 0755 /usr/local/libexec
install -o root -g root -m 0755 "$source_dir/forced-entry.sh" /usr/local/libexec/doodle-forced-entry
install -o root -g root -m 0755 "$source_dir/handler.py" /usr/local/sbin/doodle-deploy
install -o root -g root -m 0644 "$source_dir/doodle-backend.service" /etc/systemd/system/doodle-backend.service
printf '%s\n' 'doodle-deploy ALL=(root) NOPASSWD: /usr/local/sbin/doodle-deploy *' > /etc/sudoers.d/61-doodle-deploy
chmod 0440 /etc/sudoers.d/61-doodle-deploy
visudo -cf /etc/sudoers.d/61-doodle-deploy
cat > /etc/ssh/sshd_config.d/62-doodle-deploy.conf <<'CONF'
Match User doodle-deploy
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    AllowTcpForwarding no
    AllowStreamLocalForwarding no
    AllowAgentForwarding no
    X11Forwarding no
    PermitTTY no
    PermitTunnel no
    PermitUserRC no
    ForceCommand /usr/local/libexec/doodle-forced-entry
Match all
CONF
sshd -t
systemctl reload ssh
systemctl daemon-reload
# Application remains disabled/inactive until its reviewed release is installed.
printf '%s\n' 'Isolated Doodle deployment infrastructure provisioned; application not started.'
