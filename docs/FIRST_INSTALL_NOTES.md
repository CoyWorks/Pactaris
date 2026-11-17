# First installation: incidents, fixes and regression requirements

Recorded 16 November 2026. Read this before changing installer/update/resume tooling, Identity bootstrap, credentials, TLS/proxy configuration or public routing. These lessons are repository requirements, not conversation-only context.

Evidence is the operator's terminal output and confirmations from the first co-located deployment on `cw-web01`. It is not an independently repeated clean-install, split-host or production readiness assessment. Never copy real credentials or private keys into this document, fixtures or Git.

## What happened and what must remain fixed

| Incident / observation | Resolution / required behavior for future edits |
| --- | --- |
| Empty-server instructions assumed apt packages, Node, Docker and PostgreSQL already existed. | Provide prerequisites in order; CloudPanel's fresh-host installation comes before application provisioning. The future installer provisions dependencies automatically and preserves an existing CloudPanel/unrelated sites. See FRESH_SERVER.md and INSTALLER_EXPERIENCE.md. |
| Product/deployment identifiers used an obsolete internal placeholder. | Product name, package namespaces, paths and service/Compose prefixes use Pactaris. Existing installed service users/paths/Compose project names and volumes must never be renamed incidentally by an update. |
| Identity and npm appeared frozen because subprocess output was entirely hidden. | Start messages and 15-second waiting messages expose progress without command arguments/credentials. Initial authentik database migrations may take minutes. Read actual container health/logs before diagnosing a persistent failure. Do not infer npm completion from a successful registry HEAD request. |
| Ctrl+C left staged releases/config/secrets/containers but no completion state; status misleadingly said not installed. | `resume.sh` resumes a staged first install at its original exact SHA. Status distinguishes incomplete from absent. Cancellation stops the active child command group, while Docker containers/data remain. Never delete databases, volumes, secrets, config or release directories to bypass guards. Completed components are not resumed again. |
| Bootstrap uses `umask 077`; generated directory permissions could prevent the service user traversing paths/reading runtime or TLS files. | Explicitly set service ancestor traversal, root-owned service-group-readable releases, TLS-directory access and protected file permissions. Test under a restrictive umask; granting world-write or making the runtime user own activated source is not a fix. |
| Instance built successfully but `pg_dump` exited 1 before activation. | A full URI in environment-supplied `PGDATABASE` was not expanded into connection parameters in the native libpq reproduction. The fix splits host/port/db/user, decodes URI values, preserves supported TLS options, rejects unsupported options and uses a temporary mode-0600 PGPASSFILE. No password in command arguments or PGPASSWORD. Keep the backup gate mandatory. |
| Generic captured errors hid the real pg_dump failure. | On pg_dump failure preserve a private stderr log, show its path, retain only `database.sql.partial`, and promote to `database.sql` only on success. Temporary password files are removed on ordinary success/failure. Do not print unrestricted tool stderr or mark a partial dump complete. |
| New repair tooling needed to finish an older staged release. | Source checkout/tooling revision and installed runtime revision are distinct. Fetch/select reviewed tooling in `/opt/pactaris-source`; pass the original staged SHA to resume. Switching the tooling checkout does not upgrade either installed component. |
| Public HTTPS and successful responses did not establish backend certificate verification. | Explicit proxy_ssl_verify, trusted CA and certificate-matching SNI/name are required even on loopback. Test the direct backend using curl --cacert/--resolve without -k, and test public ingress separately. TLS name/CA failures must fail closed. |
| Generating/verifying identity.crt on disk did not replace authentik's default self-signed certificate (CN authentik default certificate, SAN DNS:*). Enabling verification then produced public HTTP 502. | Import the existing leaf certificate AND its key into authentik, select it as the matched/default Brand's web_certificate, and verify it is actually served on 9443. Root-CA trust alone does not activate a certificate. Configure the backend first, verify directly, then enable proxy verification. Do not disable verification as the remedy. |
| Admin UI was unreachable after the proxy correctly rejected the Identity backend. | Recovery used the healthy worker container's official ak import_certificate command, followed by selecting the web certificate through ak shell on the relevant Brand. The first deployment used the existing default brand (domain authentik-default). Restarting only the server container activated the certificate; temporary container key/cert copies were removed. Preserve signing keys, flows and unrelated brands/settings. |
| OIDC client-secret was not visible to the operator. | Explicit rotation retained the provider's client ID and stored the new secret only in `/etc/pactaris/bootstrap/instance1-oidc.secret`, root-only mode 0600. The operator reported success. Automated bootstrap must securely generate/deliver credentials and preserve them on reapply; secret rotation is explicit. No secret values in logs/chat/Git/browser code. |
| Direct public Instance hostnames/callbacks were useful for the alpha but do not match the final product entry. | Visitors choose authorized households at one configured public origin; private placement/gateway routing hides Instance hostnames. The direct-instance OIDC blueprint is transitional. Do not silently repoint a running callback/issuer/client while implementing the gateway. |
| Responses included duplicate proxy/application security headers, and nginx -t reported missing OCSP responder URLs. | Syntax validation/reload and HTTP responses still succeeded in the observed test. Header duplication remains cleanup work: define ownership of Referrer-Policy/X-Frame-Options/CSP/etc. Do not confuse OCSP notices with backend certificate-chain/name verification failures or disable TLS validation to remove them. |

## Known installed state at foundation acceptance

- Runtime release: `ed86e4261d3e551b5dee03aabc17d74042d9cc09` (`0.1.0-alpha.1`).
- Repair tooling used for final successful Instance resume: `39d8661762202e011d4923714312fe66df7f3b10`.
- Independent roots: `/opt/pactaris/identity` and `/opt/pactaris/instance`; operator source checkout: `/opt/pactaris-source`; bootstrap config/keys: `/etc/pactaris/bootstrap`.
- Identity HTTPS backend: `127.0.0.1:9443`; Instance: `127.0.0.1:9444`; existing CloudPanel admin: 8443. These are this deployment's values, not feature-code constants.
- Operator's Identity Compose prefix: `pactaris-identity-3c66393f1007`. It is path-derived deployment state, not a constant for other servers.
- Backend trust copy used by NGINX: `/etc/nginx/pactaris/backend-ca.crt`, public CA certificate only. The CA signing key remains private; do not copy it into NGINX trust directories or remote Instances.
- Identity web certificate: `Pactaris-Identity-TLS`, signed by the internal CA, matching `identity.coyworks.nl`. This is distinct from the OIDC signing certificate.

## Observed passing checks

Later Brand/TLS regression: the operator reported a healthy gateway with login-unavailable while public Identity returned 502. Direct CA-verified TLS failed and openssl showed authentik's default self-signed DNS:* certificate, despite healthy Identity containers. Recovery backed up the Identity DB/config, selected the actual request-matched Brand, restored its existing Pactaris web-certificate association and restarted only the Identity server. The operator confirmed login worked afterward. Future branding/Brand selection must preserve the matching web certificate; container health alone cannot prove NGINX upstream TLS readiness. Do not infer that an application update changed the IdP merely from timing; preserve component logs and the distinction between Compose health and verified ingress. No CSS/logo/flow/account/issuer/client changes were required for this recovery.

| Check | Operator-provided result |
| --- | --- |
| Identity container state | PostgreSQL, server and worker healthy |
| First operator account | Created; root URL subsequently redirected to the authentication flow rather than /setup |
| Independent component status | Identity and Instance reported ready: true after resume |
| Restart/reboot | Operator confirmed restart worked; both component statuses were ready afterward |
| Instance direct TLS readiness | curl with CA verification and explicit name/address returned status ready |
| Public HTTP redirects | Both current test domains returned 301 to their own HTTPS origins |
| Public Instance readiness/status, including a separate client | HTTP 200; readiness ready; version 0.1.0-alpha.1; authentication not_enabled |
| Public Instance session endpoint | HTTP 401 authentication_required, expected before session implementation |
| Identity after certificate activation | Direct CA-verified HTTPS returned 302 to the login flow; public NGINX route returned HTTP/2 302 instead of 502 |
| OIDC secret rotation | Operator confirmed the controlled reset worked; no secret value was supplied to the repository |

These prove the specific foundation paths observed. They do not prove complete data restore, signed-release validation, negative certificate rejection tests, private-repository updates, two-version runtime upgrades, split-host operation or multi-tenant isolation.

## Open follow-up work

- #56: implement the normal two-question (components and hostname) installer, including provisioning, safe enrollment, OIDC/secret/bootstrap/TLS/proxy automation and renewal. Manual repair commands must not become the normal setup UX.
- #58: define gateway session/delegation and public callback ownership before implementing the login. Use the configurable public product origin and household selection; Instance endpoints remain private.
- #6: implement callback/session and actual local/Google/Apple login acceptance. The blueprint is configuration preparation; creating a provider or resetting a secret is not an end-to-end login test.
- #62: repeat clean installs, co-located/split-host deployments, TLS failure/renewal cases, update/recovery and household-isolation/outage tests.
- Header ownership, full media/off-host backups/restore and certificate expiry/renewal remain operational work. Internal leaf certificates created during this install are valid for 365 days; renewal is not automated by the current alpha.

## Editing rule

### One-command update checkpoint

The owner explicitly requested that update.sh fetch current main and update installed components without manually supplying SHAs/components. The new wrapper applies by default; --check is the explicit plan mode. It fetches one commit and hands off to that commit's updater/deployer without resetting the operator checkout. Existing mandatory backups, separate migration/backup credentials, health checks and per-component locks are retained. Unchanged Identity Compose deployments remain running; provider image changes require a separate reviewed upgrade. Retry preserves an inactive failed staging directory rather than deleting it or touching current/data/config. Tests cover component discovery, one-revision orchestration, no-op health checks, provider blocking, stop-on-failure, cancellation and staging preservation. Live root/systemd/Docker/private-source retry acceptance still requires operator observation.

A future change must retain the protections above or document and test an intentional replacement. Link new regressions/fixes back to this record and the relevant issue. Preserve the distinction between locally tested code, operator-observed host behavior and planned automation. Never re-run destructive bootstrap or rewrite active deployment values merely because an example/default changed.

See [RECOVERY.md](RECOVERY.md), [FRESH_SERVER.md](FRESH_SERVER.md), [IDENTITY_OIDC.md](IDENTITY_OIDC.md) and [INSTALLER_EXPERIENCE.md](INSTALLER_EXPERIENCE.md).

## Relationship migration checkpoint — 0.6.0-alpha.1

The additive Instance 0007 relationship migration preserves historical scaffold rows without exposing or accepting them. The preserving updater must activate the Instance before the gateway. No Identity configuration, issuer/client/Brand/web certificate, credentials, backend TLS or proxy changes are required. Database fallback is not a consent/relationship rollback; ended memberships/relationships must never be restored by application fallback. Runtime receives only the narrow relationship command grant; backup remains read-only and separately protected. Native CI and live operator/mobile acceptance remain distinct evidence. See [RELATIONSHIPS.md](RELATIONSHIPS.md).

## Consent and safety checkpoint — 0.7.0-alpha.1

Additive Instance 0008 requires Instance activation before gateway. Preserve separate runtime/migration/backup credentials, existing checksums, Identity issuer/client/flows/Brand/web certificate, TLS/proxy/domain configuration and all data. No new operator secrets/configuration are needed. Gateway restart intentionally discards short-lived emergency route cache; refresh an authenticated household page while central services are healthy to prepare a new restrictive connection. This bounded manager-DB outage path still needs a reachable gateway and Instance; it is not offline or host-failover delivery. Application fallback must never be described as a consent/safety rollback. Trusted revocation/deletion replay after restoring older backups remains an open release gate. See [CONSENT_SAFETY.md](CONSENT_SAFETY.md).

## Everyday workspace checkpoint — 0.8.0-alpha.1

Additive Instance 0009 adds household settings/private tasks and preserves configured entitlements (initial tasks.active.max pilot default 25 only when absent). Activate Instance before gateway through the existing updater; preserve all earlier migration checksums, config/secrets, runtime/migration/backup roles, Identity issuer/client/flows/Brand/web certificate, domains, TLS and proxy settings. No new operator configuration is needed. Task departure cleanup releases active capacity for the ended membership only; rollback/restore must not recreate its authority. See [WORKSPACE_TASKS.md](WORKSPACE_TASKS.md); live operator/mobile acceptance and trusted off-host revocation/deletion restore replay remain separate gates.
