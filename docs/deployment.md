# Backend deployment

The new backend is deployed independently of the legacy application. Related
requirements: NFR-001–012. This pipeline deploys only the tested `main` revision;
it does not provide access to university accounts or prove live SSO support.

## Target and isolation

The owner-selected target is SSH alias `mnema`, Ubuntu 24.04 x86_64. Existing
Mnema containers, database, Caddy routes, SSH and network services are protected.
Doodle uses these isolated resources:

| Resource | Purpose |
|---|---|
| `/opt/doodle/node` | Isolated, checksummed Node 24.21.0 runtime |
| `/srv/doodle/releases/<40-character SHA>` | Immutable root-owned application and built web assets |
| `/srv/doodle/current`, `/srv/doodle/previous` | Atomic release pointers |
| `/etc/doodle/backend.env` | Root-owned mode-0600 runtime credentials and configuration |
| `/var/lib/doodle/platform.sqlite` | Persistent SQLite data; service user `doodle` |
| `/var/backups/doodle` | Root-only consistent pre-release SQLite snapshots |
| `doodle-backend.service` | Sandboxed nonroot service, loopback `127.0.0.1:18110` |
| `doodle-deploy` | Dedicated SSH identity; fixed deployment commands only |

`ops/deploy/bootstrap.sh` is a **one-time administrator script**. It deliberately
refuses existing Doodle accounts/directories/configuration rather than overwriting
them. Supply a newly generated dedicated `deploy-key.pub` beside its files;
never copy a personal private SSH key. The script installs the handler, service,
restricted sudo rule and per-user SSH restrictions. Validate SSH configuration
before reload. Bootstrap leaves the application disabled/inactive. The first
healthy release enables it for reboot startup.

## Credentials and readiness

Repository configuration:

- Secret `DOODLE_DEPLOY_SSH_KEY`: dedicated CI private key, unrelated to owner SSH keys.
- Secret `DOODLE_DEPLOY_KNOWN_HOSTS`: existing independently trusted server host key.
- Variable `DOODLE_DEPLOY_HOST`: selected server address.
- Secret `DEEPSEEK_API_KEY`: owner-authorized provider key; never printed in logs.
- Secret `TELEGRAM_BOT_TOKEN`: confirmed intended bot credential.
- Secret `TELEGRAM_WEBHOOK_SECRET`: independent webhook authentication secret.
- Variables `PUBLIC_BASE_URL` and `PUBLIC_BOT_USERNAME`: public app/bot metadata.

Application credentials are supplied directly to `/etc/doodle/backend.env`, not
included in release archives. Setting the GitHub DeepSeek secret alone does not
update runtime configuration. No CI step sends GitHub secrets through arbitrary
remote shell commands. Each student’s source credentials are encrypted in SQLite;
they are not separate repository secrets.

The root environment needs `NODE_ENV=production`, `HOST=127.0.0.1`, `PORT=18110`,
`DOODLE_DB_PATH=/var/lib/doodle/platform.sqlite`, a new base64-encoded 32-byte
`DATA_ENCRYPTION_KEY`, `DEEPSEEK_API_KEY`, `DEEPSEEK_MODEL`, and the chosen HTTPS
`PUBLIC_BASE_URL`. Configure `TELEGRAM_BOT_TOKEN` only after identifying the
intended bot and checking that no other instance consumes its updates. Optional `TELEGRAM_WEBHOOK_SECRET` is generated privately and stored as a
GitHub secret and in the runtime environment. Webhook registration waits for
the selected bot and public HTTPS URL. Preserve the external
master key with encrypted database backups: losing it prevents credential recovery.
Do not rotate it without a data re-encryption plan.

`/healthz` reports process health and exact `APP_VERSION` Git SHA. Health alone
does not prove Telegram/provider readiness, source-account access or public HTTPS.
A missing bot token must leave protected APIs closed; all authenticated bot users
are allowed once Telegram is configured. Never introduce a development identity.

## CI trust and release sequence

`.github/workflows/deploy.yml` runs after `CI` completes successfully for a push
to this repository’s `main`. It verifies the CI workflow ID, run event, repository,
branch, full SHA and latest `main` through GitHub’s API before executing source.
It checks out that exact SHA with no persisted credentials. Actions are pinned
to immutable commits. It installs locked backend dependencies without lifecycle
scripts, builds web assets, then creates a fresh archive from the trusted source.
It never executes artifacts supplied by pull requests. A second latest-main check
prevents an older queued build from replacing a newer main revision.

The SSH key is exposed only after the build. Strict host-key checking is required.
The key cannot run arbitrary shell, forward ports/agents, request a TTY, run user
RC or use password authentication. Its forced handler accepts only:

```text
status
install <40-character Git SHA> <64-character archive SHA-256>
rollback <exact previous SHA>
```

`install` reads one bounded archive on stdin; verifies its digest, member paths,
types, size and release metadata; rejects symlinks and traversal; and writes only
backend source, installed runtime dependency files and built web assets. Releases
are root-owned and never overwritten. Application code runs only as `doodle`.
The handler serializes operations, saves a consistent DB backup when present,
atomically switches `current`, restarts this service only, and requires
`GET http://127.0.0.1:18110/healthz` to return `status: ok` and the expected SHA. Additional readiness fields are
allowed and reported independently from process health.
On startup/health failure it restores the previous pointer and verifies that
release; a failed first deployment stops the new service. Backups and old releases
are retained: there is no automated cleanup or database restore.

CI concurrency serializes deployment and never cancels an in-progress activation.
Runtime does not require repository checkout, GitHub access, npm installation,
Docker or proxy reloads. Normal releases do not touch Caddy.

## Verification and rollback

Before a production rollout, record exact reviewed SHA, current/previous SHA,
unit health, free disk, public hostname and existing Mnema health. New database
changes must remain backward compatible with the previous release; otherwise
stop and plan the migration, backup/restore and data recovery explicitly. The
automatic rollback switches **code only** and cannot undo a destructive migration.
Database restore is an administrator operation requiring an explicit data-loss
assessment. Initial installation uses a new database and does not migrate legacy
student data.

After activation verify exact SHA health, service startup/restart state, public
HTTPS/static assets and unauthenticated API rejection. Use synthetic accounts
for authenticated smoke tests. Observe for at least two minutes and inspect
bounded, redacted service diagnostics; never dump environment or raw personal data.
Check the existing Mnema services and public routes still work. Stop on any
unexpected access, unrelated-service degradation, version mismatch, backup failure
or exhausted disk. The handler attempts code recovery within about one minute;
failed rollback requires an operator and is reported as a failure, never success.

For a manual rollback, query `status`, review its exact `previous` SHA and call
`rollback <that SHA>` through the dedicated identity. The handler applies the same
health gate. Keep the master key, environment and DB outside release directories.
Do not run broad service restarts, Docker cleanup or network changes.

The public hostname is `doodle.mnema.app`, with DNS pointing to the selected
server. Its dedicated site is `/etc/caddy/doodle.caddy` (source:
`ops/deploy/doodle.caddy`), imported by the preserved existing Caddyfile. Public
proxy setup is a separate one-time administrator action after DNS resolves to
the target. Add only the Doodle hostname,
validate the complete existing Caddy configuration, reload once and verify all
pre-existing routes. Never replace the server’s Caddyfile with this application’s
configuration.

## Checks and initial provisioning (2026-10-25)

The deployment handler has synthetic tests for checksum rejection, traversal,
symlink rejection, immutable releases, version files, failed startup/first-release
recovery, consistent SQLite backup and successful previous-release preservation:

```sh
python3 ops/deploy/test_handler.py
bash -n ops/deploy/bootstrap.sh
sh -n ops/deploy/forced-entry.sh
```

Initial provisioning created the isolated infrastructure, dedicated GitHub secrets
and runtime configuration without exposing credentials. The restricted identity’s
status succeeded and arbitrary `id` was denied. The service was deliberately left
disabled/inactive until the first reviewed release; this is a provisioning record,
not a statement of the current runtime version.

The intended bot is `@botAI_agent_bot`, verified through read-only `getMe`.
Before cutover its webhook was empty with zero pending updates. `PUBLIC_BASE_URL`
is `https://doodle.mnema.app`; the independent webhook secret and dedicated Caddy
import are configured. TLS verification succeeded before application activation.
The configured `deepseek-flash` model was present in an authenticated model-list
response. This does not verify generated answers or university access.

For the current release, consult the successful Deploy run and
`https://doodle.mnema.app/healthz`, then verify private API rejection and webhook
configuration as described above. Record actual rollout evidence on the release
PR; do not infer current readiness from this initial provisioning snapshot.
