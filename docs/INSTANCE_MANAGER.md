# Platform operator portal and distributed Instances

Confirmed owner requirements, 17 November 2026. Planned scope: #55/#57/#58/#59/#60/#62. Everyday owner-only dashboard/settings/tasks remain the immediate feature priority in EARLY_VERSION_BASICS.md. The Gateway has a read-only placement registry view. The remaining sections describe the planned enrollment, network and relocation scope.

## Networks and trust

Instances may live on different LANs, providers and geographical locations. A shared local network or CloudPanel installation on every host is not required. Each keeps its own runtime, PostgreSQL, private files, worker and backups under distinct credentials.

Use enrolled, authenticated connectivity between gateway/manager and each Instance. A routed private overlay or controlled outbound tunnel can connect otherwise separate/NATed networks. Specify enrollment, key rotation/revocation, routing/DNS, expiry and outage behavior before implementing that transport. Never publish tenant databases, trust an arbitrary administrator-supplied redirect target, disable backend TLS, or turn the gateway into an unrestricted proxy. The current private-address-only HTTPS client is a useful boundary, not an implemented remote connectivity/enrollment solution. Public direct-backend support, if ever needed, requires a separately reviewed endpoint/SSRF/trust policy.

## Separate operator portal

Platform administration is distinct from household owner/admin and contextual Dom/sub roles. Only authorized platform operators can view the fleet or request lifecycle operations. Require appropriate MFA/step-up for sensitive operations and audit the operator, scope, operation ID, result and timestamps without recording secrets or intimate household content.

| View | Required information/actions |
| --- | --- |
| Fleet | Stable Instance ID, operator label, region/network label, lifecycle, health/last contact, application/schema/protocol version, capacity/usage, household count, backup freshness |
| Instance | Connectivity/compatibility status, operational warnings, minimal household inventory, enrollment/credential rotation and supported maintenance/drain actions |
| Household placement | Stable household ID, optional operator-facing reference/label, current home/placement version, operational size/status and permitted migration targets |
| Migration | Source/target, preflight, transfer/verification/cutover progress, failure/recovery state and audit trail |

Counts and inventory must have a freshness timestamp; an offline Instance is not reported as having zero households. Placement metadata must reconcile with Instance reports. An operator-facing reference is operational metadata, not automatic collection of household-authored names, member lists or relationship labels. Do not centralize tasks, agreements, limits, relationship graphs or private notes for an inventory screen. Any later decision to expose a household-authored display name to operators needs an explicit minimal metadata/privacy contract. Operational authority is not routine access to intimate content.

## Controlled household relocation

1. Select an enrolled target and run compatibility, capacity, connectivity and backup checks. Prepare an isolated inactive import and a durable migration operation ID.
2. Fence source writes under a declared maintenance policy. Handle in-flight commands and new/deferred operations explicitly. A household has one writable home throughout the move.
3. Export/import only that tenant's records and private files, preserving stable household/account/membership/resource IDs, agreements, revoked consent, safety epochs/holds, audit, entitlement/usage state, receipts/jobs/outbox and deletion/revocation tombstones.
4. Verify manifest/checksums/counts and authorization mapping. Reconcile effect delivery so notifications, points, payments and recurring work are not duplicated.
5. Atomically change the authoritative placement and version, activate the verified target and keep the source fenced. Reject old source/audience/placement commands. Explicitly invalidate/re-establish short-lived emergency routes/grants and handle offline clients and old PWA/push/feed links; do not make a previously prepared grant authorize both copies.
6. Verify the canonical user workflow, record success and retire the source copy/credentials under a reviewed retention/cleanup policy. A failed operation exposes recovery status and preserves one authoritative home. Post-cutover recovery must reconcile newer target writes/revocations; blindly switching back to an old source is not a rollback.

Transfer encryption, isolated temporary storage and credential scoping are required. No live dual-write mesh, zero-downtime promise or cross-tenant database access is implied. Rehearse at least two households on different network segments with disconnects, failed verification, duplicate commands and interrupted cutover, proving the uninvolved household remains isolated.

## Hidden end-user routing

Users remain on the configured canonical product origin for login, dashboard, household switching, APIs and files. The browser selects an authorized household ID; the gateway resolves current private placement. It receives no private backend address or reusable backend credential and is never redirected to an Instance host.

Apply that boundary to links, callback/redirect locations, error messages, response headers, downloads, PWA/push payloads and migration notices. A migration may show a generic maintenance state, but never requires the user to select a server, change accounts or learn where the backend lives. Separate infrastructure/operator URLs from product household labels.

## Later personal relationship mode

Issue #71 tracks a personal-first standalone relationship experience. It shows only the current person's authorized relationships, partners and the agreements between those participants, without making household management the main UI. The existing graph must never imply that every household member is connected to every other member.

This is later product scope. Decide whether a relationship uses an existing tenant or an internal dedicated container before implementing creation/invitations, placement or independent relocation. Keep one identity, explicit participation, contextual multi-role support and participant-level privacy; do not duplicate a relationship across households or silently expose one partner's other relationships. Reuse the same invisible Instance routing. This is not a new self-hosted edition.

## Two-Instance rehearsal

The integration suite runs two HTTPS Instance listeners and independent PostgreSQL databases with distinct component roles. It checks one account across both placements, an unrelated household, and a TLS-name failure on one Instance. During that failure the Gateway still serves the healthy household, reports a partial list and returns a generic unavailable response for the affected household. It verifies recovery at the same browser origin after restoring trust. The fixture runs on a single CI runner.

For hosted acceptance, place synthetic households on two isolated routes behind CloudPanel and follow PUBLIC_SMOKE.md. Record revisions and observed results for authenticated switching, a backend TLS or route failure, recovery, and the safety path with the control plane unavailable. Exercise Identity outage separately from shared ingress loss. Enrollment, revoked credentials, restore and migration fencing need their own hosted rehearsals once their lifecycle tooling is available.
