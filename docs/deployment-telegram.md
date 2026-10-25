# Production Telegram delivery

The Mini App remains at `https://doodle.mnema.app` and its DNS record is **DNS
only**. Its student API requests, source credentials and uploaded authentication
data go directly to the owner’s server. The intended bot is `@botAI_agent_bot`.
The bot’s WebApp menu points to the direct Mini App URL.

`telegram.org` is unreachable from Russian networks, so the Mini App serves a
pinned copy of `telegram-web-app.js` from its own origin
(`jarvis-app/web/public/`). Its boot path must not load scripts from Telegram
domains: a blocking external script hangs the page for students without a VPN.

Telegram webhook updates use the separate host
`https://doodle-hook.mnema.app/api/telegram/webhook`. Only this hostname is
proxied through Cloudflare. It has an explicit A record for the owner-selected
server, overriding the zone’s older wildcard record. Do not change the wildcard,
the direct Mini App record or any other Mnema host to maintain this route.

## Isolation and trust

Cloudflare terminates TLS for the webhook host and can observe Telegram update
data and the webhook authentication header. This is an owner-approved additional
trust boundary for bot updates. Student source credentials and the Mini App API
must not be routed through this host. Do not log webhook bodies or secret headers.

The zone-wide SSL setting is preserved. A hostname-specific Configuration Rule
matching `http.host eq "doodle-hook.mnema.app"` must set SSL to **Strict**, so
Cloudflare validates the origin certificate. Do not weaken certificate validation,
use Flexible mode or change the shared zone’s SSL/security settings for this app.
The Caddy certificate must cover the hook hostname and remain valid.

The dedicated [site configuration](../ops/deploy/doodle-hook.caddy) accepts only
`POST /api/telegram/webhook` and forwards it to `127.0.0.1:18110`. All other
application routes return 404. The backend still checks the constant-time webhook
secret before parsing or processing updates. Cloudflare routing is not an
authentication mechanism; forwarded headers do not establish a student identity.

## Provisioning and certificate renewal

The owner-operated setup is separate from normal releases:

1. Create only the hook hostname’s explicit A record in DNS-only mode.
2. Preserve and back up the existing Caddyfile, install the new site as
   `/etc/caddy/doodle-hook.caddy`, and add one import to the existing configuration.
3. Validate the complete Caddy configuration before a single graceful reload.
4. Obtain the origin certificate and verify hostname/CA validation from outside
   and through local Caddy, without disabling certificate verification.
5. Enable Cloudflare proxy for this hostname and its hostname-specific Strict
   rule. Verify the rule and end-to-end route before registering the new webhook.
6. Update the existing bot’s webhook URL using the same private webhook secret,
   `allowed_updates: ["message"]` and `drop_pending_updates: false`. Read back
   the URL, destination IP and pending count. Never consume real updates using
   `getUpdates` during verification.

Caddy’s HTTP-01 challenge requires Cloudflare to forward
`/.well-known/acme-challenge/` on port 80 to the origin without interception.
TLS-ALPN-01 cannot pass through the Cloudflare edge. Keep HTTP-01 reachable for
renewal and monitor renewal failures. Any temporary DNS-only certificate
bootstrap affects only this hook record and requires the owner’s authorization;
never change global redirects, WAF or protected Mnema settings as a shortcut.

Normal successful-main deployment releases do not edit DNS, Cloudflare rules or
Caddy. They replace only the isolated backend/static release and preserve this
hook site, runtime credentials, database and the direct Mini App host. See the
[backend runbook](deployment.md) for the immutable releases and health rollback.

## Replies and verification

Direct Telegram transport from the selected server has exhibited TCP connection
timeouts. Host routing, public IPv4, listening 443 and explicit UFW 443 allow were
checked; a bounded capture showed outgoing SYN retransmissions without replies.
No host firewall, route, VPN or protected service was changed to address this.
Cloudflare provides a separate ingress path for webhook delivery.

A private `/start` reply is returned as a Telegram Bot API method in the webhook’s
JSON response. The application performs no outbound `sendMessage` call for this
welcome message. Repeated updates acknowledge with `{ "ok": true }` instead of
repeating the method. The application cannot confirm the result of a Bot API
method returned this way. Future asynchronous notifications still require working
outbound Telegram transport and are not proved by this welcome-response flow.

Verify exact reviewed release SHA and readiness through the **direct** `/healthz`.
On the hook host, require 404 for `/`, private API paths, GET on the webhook and
POST with an invalid secret. A private authenticated synthetic update with an
impossible fake chat ID can verify the returned method and duplicate acknowledgement:
a normal HTTP client does not execute that returned Telegram method. It must not
send real messages, consume pending updates or write a synthetic student record.

Cloudflare may reject a library-default User-Agent with error 1010. Use a truthful
descriptive deployment User-Agent for diagnostics; do not disable global Browser
Integrity Check or Bot protection to make a probe pass. A process-only TLS 1.2
client with normal hostname/CA verification can diagnose local TLS handshake
problems without changing server policy. Actual delivery is established by
`getWebhookInfo` pending updates draining and no newer delivery errors, not by
synthetic probes alone. Historical error fields can persist after recovery.

Observe service health, exact SHA, restart count and protected Mnema services for
at least two minutes after cutover. Report any pending count or fresh timeout
honestly. Preserve queued updates throughout recovery.

## Targeted rollback

Restore the prior webhook URL
`https://doodle.mnema.app/api/telegram/webhook` with the same secret, message filter
and pending preservation, then read back the result. This restores the previous
configuration; the direct transport limitation may still apply. If the hook site
must be removed, restore only its exact Caddy import/site backup and validate
before reloading. Change only this hostname’s DNS/rule when explicitly authorized.
The direct Mini App, other Mnema sites, runtime keys and SQLite data remain outside
this rollback. Never restore a database or restart unrelated services for a
webhook routing change.

The Bot API’s webhook-response limitation is described in the
[official Telegram FAQ](https://core.telegram.org/bots/faq#how-can-i-make-requests-in-response-to-updates).
Cloudflare’s hostname-scoped SSL setting is documented under
[Configuration Rules](https://developers.cloudflare.com/rules/configuration-rules/settings/).
