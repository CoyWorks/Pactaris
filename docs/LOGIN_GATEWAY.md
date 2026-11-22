# Central login and household gateway contract

Implementation slice for #4/#5/#6/#8/#55/#56/#58. Product domain confirmed by the owner: pactaris.app. Canonical public app and Identity origins remain explicit configuration; the existing CoyWorks installation is not changed by a source update.

## Ownership and trust

CloudPanel terminates public HTTPS and forwards to the separately supervised Node gateway (default private HTTPS port 9445). Authentik remains independently managed at 9443; each Instance remains independently managed at 9444 with its own database. The gateway owns the host-scoped browser session, OIDC client secret and minimal routing metadata. An Instance never receives that cookie, the OIDC secret or IdP access/ID tokens.

OIDC uses maintained openid-client, Authorization Code + S256 PKCE, state, nonce, required ID-token signature/issuer/audience validation and a one-time five-minute database-backed login attempt bound to a Secure HttpOnly browser cookie. Accounts are identified by verified issuer + subject and receive a stable platform UUID; email never links accounts or supplies authorization. Provider tokens are discarded after verified identity extraction. Local sessions have 30-minute idle and eight-hour absolute bounds by default (the installed app signs in again automatically; see [PASSKEY_SIGN_IN.md](PASSKEY_SIGN_IN.md)), with database-backed logout/revocation and suspended-account checks. Local logout does not claim to terminate the IdP session or other devices.

Each gateway-to-Instance request is a narrowly scoped Ed25519-signed delegation, valid for at most 30 seconds, bound to instance audience, platform account UUID, household UUID, HTTP method/path and purpose. Instances pin explicitly configured gateway public keys/issuer, reject replay using a database uniqueness constraint and verify current local membership before establishing household context. Do not trust browser identity headers or redirect to an Instance. Certificate verification is mandatory for private requests, including loopback. Only registered private HTTPS endpoints are eligible; never take a target URL from a browser.

The first data-plane contract exposes only an authenticated household summary (id and display name), not a general-purpose transparent proxy. Future tasks/files routes need their own method/path/purpose contracts and tests. The SPA and API remain at the configured app origin. No Instance URL/address/id is included in household/session responses, links or user-visible errors.

## Data boundaries

Gateway PostgreSQL owns accounts, hashed browser-session identifiers, short-lived OIDC attempts, throttling counters, registered Instance endpoints, placement versions and account/household visibility hints. It stores no task, relationship, scene, limit or household-name content. Hints are not authorization: every displayed name is fetched through live local membership checks. Revoked hints cannot bypass an Instance. If one backend cannot be checked, the API reports a partial listing with no private target details; it does not invent an empty household or a successful stop.

Each Instance owns households, memberships, contextual relationship graphs/roles, consent/audit/entitlement schema foundations and replay markers. Runtime roles are non-owner/non-superuser/NOBYPASSRLS. SQL transactions set verified account context first, check a current active membership, then set household context. RLS adds a second boundary; pooled connections use SET LOCAL and cannot leak context between requests. No dynamic role label grants technical rights. Household creation/invitations/consent/task APIs are separate future slices; this release must show a truthful empty state for a new account.

Manager provisioning/synchronization remains operator-only in this slice. No public registration endpoint can populate arbitrary routing records. Metadata bootstrap is documented; the two-question installer and full manager enrollment remain #56/#57. Global IdP revocation is bounded by local absolute session expiration until supported logout-event integration ships (#7); do not claim instantaneous fleet revocation.

## Migrations and activation

Keep reviewed component migrations and checksums in the release manifest. Run them with separate migration credentials after mandatory backups and before service activation, under a PostgreSQL advisory lock and transaction. Runtime startup checks its required schema version and privileged-role state. The initial migrations are additive and compatible with the previous health-only application; code fallback does not remove schemas or roll back a database. A checksum mismatch/missing migration secret/unhealthy database blocks activation.

Gateway is an advanced independently deployable runtime for the central profile. The normal future installer still asks Identity/Instance/both; central-profile orchestration will provision the gateway without an extra routine question. Do not mix its sessions/data into authentik's database or an Instance database.

## Acceptance

Verify actual JWT signature/issuer/audience/nonce/state/PKCE/code-replay failures using a controlled OIDC fixture, persistence and expiration, session fixation/CSRF/logout, two account/household boundaries, real PostgreSQL RLS/pool reuse and wrong-Instance/replayed delegations. Check startup, migration repeat/checksum failure, health gates and preserving update behavior. Real authentik/social-provider acceptance and the live CloudPanel/domain cutover remain an operator rollout gate.

## Verification evidence

The implementation branch passed local type/i18n/build checks and controlled signed-token/OIDC tests. [Native PostgreSQL/HTTPS CI](https://github.com/CoyWorks/Pactaris/actions/runs/43878293911) passed against two separate Instance databases plus the gateway, non-superuser schema/runtime roles, RLS/pool reuse, replay rejection, wrong certificate names, current membership revocation and private routing. The integration harness uses real HTTP requests throughout to avoid test-adapter prototype changes affecting listening Express apps. Live authentik and the root co-located bootstrap still need operator acceptance.
