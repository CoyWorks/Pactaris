# Deploy central sign-in — 0.2.0-alpha.1

Issues: #4/#5/#6/#8/#55/#56/#58. Read FIRST_INSTALL_NOTES.md before changing the working alpha. This is an operator-run pilot rollout, not public onboarding or completion of every acceptance criterion in those parent issues.

## Included

- Central Node gateway with OIDC Authorization Code + PKCE/state/nonce and ID-token signature/issuer/audience validation using openid-client.
- Database-backed, hashed browser-session identifiers; idle/absolute expiry, suspension checks, origin/CSRF-protected local logout.
- Authorized household selector, honest empty/partial/unavailable states and a selected-household summary page. No household creation/invitation/task APIs are claimed.
- Private, CA-verified HTTPS routing with short-lived Ed25519 delegations bound to subject/Instance/household/method/path/purpose, replay rejection and live Instance membership checks.
- Independent PostgreSQL schemas/migrations and supervised gateway API/worker. Runtime roles cannot own/migrate the schema or bypass RLS. Migration/backup credentials remain root-only.
- A bootstrap helper for the already installed co-located alpha. It retains existing Instance identity/DB/runtime credentials, OIDC client ID/secret and the Identity issuer; it does not replace CloudPanel, DNS, public certificates or the IdP database.

The canonical product domain is pactaris.app (owner-confirmed purchase). `publicOrigin` is configuration; no runtime code hardcodes that domain. Identity can remain on its current origin during an app-origin pilot. A later Identity issuer change requires a controlled identity/account migration; never recreate accounts by email.

## Prerequisites

A working initial Identity and Instance installation, local PostgreSQL on 127.0.0.1:5432 administered through the existing local postgres OS account, the internal CA/key under `/etc/pactaris/bootstrap`, and the imported `Pactaris-Instance1-OIDC` provider. The helper is for this known topology; split-host operators supply equivalent protected config/credentials separately. It never obtains remote DB, DNS or social-provider access merely from a hostname.

Use a reviewed full commit SHA for this release. Obtain the updated tooling first: old protocol-1 tooling intentionally rejects migration-bearing releases. Never delete current state/volumes to bypass a refusal.

## 1. Select the reviewed source revision

```bash
cd /opt/pactaris-source
git fetch origin main
# Set REVISION to the reviewed full 40-character commit supplied with this release.
git checkout --detach "$REVISION"
```

## 2. Prepare local databases, trust and OIDC configuration

The default public origin is https://pactaris.app. An explicit alternate, such as the existing configured pilot hostname, is supported. The helper prints a plan without --apply:

```bash
python3 scripts/prepare-login.py --root /opt/pactaris \
  --public-origin https://pactaris.app
```

Then apply the same plan:

```bash
python3 scripts/prepare-login.py --root /opt/pactaris \
  --public-origin https://pactaris.app --apply
```

This creates protected gateway config at `/etc/pactaris/bootstrap/gateway.json`, separate DB roles/credential files under `/etc/pactaris/bootstrap/login`, gateway TLS/delegation keys, and adds trusted gateway/public migration settings to the existing Instance config. The original Instance config is checkpointed. The provider's existing client ID/secret are retained; the current IdP issuer is discovered from preserved Identity config and the actual application slug. The exact new callback `/auth/oidc/callback` is added, with the old direct-instance test callback retained until cutover is verified. The IdP application display name becomes Pactaris; the launch URL becomes the configured public origin.

The helper refuses a conflicting role without its preserved credential, a secret mismatch, unsupported remote PostgreSQL, unsafe identifiers/permissions and an implicit public-origin change on repeated setup. It does not drop/recreate data or rotate existing secrets. A failed preparation retains created credentials for diagnosis/retry. Do not delete partial TLS keys or credential files to retry; inspect the reported stage.

Database backup roles have BYPASSRLS for full FORCE-RLS backups but only explicit schema/table read permissions; they are distinct from runtime and migration roles. Their credentials are root-only and are never staged into service-readable secrets. The migration role owns only this component's application/metadata schemas, without superuser/BYPASSRLS. The ordinary runtime has neither those privileges nor DDL rights.

## 3. Update Instance, then install the gateway

Run separately and stop on an error:

```bash
bash update.sh --component instance --root /opt/pactaris --revision "$REVISION"
bash update.sh --component instance --root /opt/pactaris --revision "$REVISION" --apply
bash status.sh --component instance --root /opt/pactaris
```

Then:

```bash
bash install.sh --component gateway --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/gateway.json --revision "$REVISION"
bash install.sh --component gateway --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/gateway.json --revision "$REVISION" --apply
bash status.sh --component gateway --root /opt/pactaris
```

If Gateway was already successfully installed, use update.sh --component gateway (without --config). `gateway` is an advanced independent runtime; the future normal Identity/Instance/both wizard will compose it in the central profile without adding another routine operator choice.

Migrations run after mandatory data/config checkpoints and before activation, under a DB advisory lock and transaction. Checksums are immutable; a mismatch blocks activation. The initial schemas are additive, so falling back to the prior health-only runtime leaves the schema in place. No database rollback is implied. A failed update retains its staged release for diagnosis; automatic interrupted-update repair is not claimed. First-install `resume.sh` remains restricted to an uncompleted initial installation.

## 4. Public ingress

Create DNS/public certificates and CloudPanel sites for the configured product origin and www alias. Gateway backend: `https://127.0.0.1:9445`. Its internal leaf certificate matches the configured public hostname by default; its issuer is the existing internal CA.

In the gateway site's reverse_proxy location, retain normal proxy/forwarded-header settings and explicitly set (adapt the name when overriding publicOrigin):

```nginx
proxy_ssl_server_name on;
proxy_ssl_name pactaris.app;
proxy_ssl_verify on;
proxy_ssl_verify_depth 2;
proxy_ssl_trusted_certificate /etc/nginx/pactaris/backend-ca.crt;
```

Preserve the working identity.coyworks.nl backend/proxy until a separate Identity-domain migration is performed. Public app and IdP origins need not share a parent domain. The public app callback is at the gateway, not an Instance. The www hostname should redirect to the configured canonical app origin.

Do not publish/route `/internal/` APIs as browser features. After validating the gateway, retire/restrict the old browser-facing Instance test site; keep its operational/private upstream connectivity. A normal user never sees a server chooser, Instance URL, data-plane token or IdP secret.

## 5. Acceptance on the real host

Before DNS/public ingress is ready, local gateway readiness can be tested without bypassing certificate checks:

```bash
curl --cacert /etc/nginx/pactaris/backend-ca.crt \
  --resolve pactaris.app:9445:127.0.0.1 \
  https://pactaris.app:9445/health/ready
```

Then from a separate client:

```bash
curl -i https://pactaris.app/health/ready
curl -i https://pactaris.app/api/session
```

Expected before login: readiness HTTP 200, session HTTP 401. Open the app and sign in. The callback returns to the same public app origin. A new account has no households; that is the expected state. Household memberships/content and authorized routing hints are not fabricated by bootstrap. This slice does not add a public household-creation or manager-enrollment endpoint. Real populated selection is covered with synthetic two-Instance integration fixtures; manager provisioning/household creation follow #8/#57.

Verify failed/cancelled login recovery, local logout, a session after restart, wrong-host/Origin rejection, expired sessions, and browser/network inspection for absence of Instance targets. Local logout removes the Pactaris session but does not terminate the authentik SSO session; MFA/recovery/global logout propagation remain #6/#7.

## Verification and limits

Local checks: npm run check; npm run build; npm audit --omit=dev. Native integration: TEST_DATABASE_URL=... npm run test:integration, using disposable PostgreSQL databases/roles and real HTTPS servers. The test creates/drops only its fixed pactaris_test_* fixture databases and must never point at production. CI provisions an isolated PostgreSQL service for this test.

The co-located root bootstrap, real authentik login and live CloudPanel/domain cutover need operator acceptance. No code push changes the running server or its DNS. Full minimal-input installer, unattended certificate renewal, private-repo/update-failure/restore rehearsal, Google/Apple, invites, consent/task APIs, billing and fleet enrollment are not declared complete by this release.
