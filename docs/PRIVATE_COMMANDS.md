# Private household commands — 0.2.3-alpha.1

Scoped implementation for #8/#12/#26 and the #68 onboarding milestone. This is the Instance-side write boundary. The public gateway create/invitation/leave workflow, durable placement reservation and cross-store reconciliation have not shipped. Never publish this route as a browser API or infer that a private write endpoint completes onboarding.

## Request contract

`POST /internal/households/{householdId}/commands/create` accepts `{operationId,name}`. `POST /internal/households/{householdId}/commands/leave` accepts `{operationId}`. A request may contain only these keys; it cannot specify the authenticated account, target Instance, technical role or entitlement. Bodies are uncompressed JSON of at most 4096 bytes. The path must match exactly, without an alternate action, query string or encoded alias.

The gateway signs a 30-second Ed25519 JWT with a distinct `pactaris-command+jwt` type. It binds the verified platform account, target Instance audience, household, action/purpose, POST method, exact path, operation UUID and SHA-256 of the exact request bytes. `jti` replay markers include the clock-tolerance window. A summary delegation cannot authorize a write and a write cannot authorize a summary. The private transport pins resolved private addresses, verifies CA/name, rejects redirects and bounds response size/deadline. Only stable result fields or redacted error classes reach the caller.

`PrivateCommandClient` is a server-side transport for an already-authorized placement. It does not authorize placement, expose an arbitrary proxy or provide a public create endpoint. Before connecting it to a browser request, implement the central reservation, session/CSRF checks, abuse budgets and receipt-based reconciliation in MILESTONE_2.md.

## Transactions and retries

The Instance verifies the signature/body binding before reading domain input. It accepts no identity from forwarding headers or JSON. A transaction writes the replay marker and calls a narrow reviewed database command. The command holds operation/household advisory locks and uses a durable operation receipt. Its semantic fingerprint permits equivalent JSON whitespace/key-order retries, while the transport still authenticates exact bytes.

- An identical retry with a fresh transport JWT returns the original receipt without another member, audit event or outbox entry.
- Reusing the exact JWT is rejected as replay. Reusing an operation UUID with another actor, target, action or changed name is a conflict.
- A database failure rolls back the household/member/receipt/audit/outbox/replay marker together. The caller must retain the operation UUID and retry with a new signed JWT after an unknown response; a timeout is not proof that nothing committed.
- A creation retry after the creator has left is denied; it never recreates membership or reopens the household.

The gateway will own durable placement/creation reservation. This checkpoint deliberately does not attempt an in-memory two-database transaction or fabricate routing hints. A private command can create a household on an Instance, but the gateway does not automatically discover it without the future central workflow. Do not use manual production creation as an onboarding substitute.

## Database privilege boundary

The additive `0002_commands` migration leaves the runtime non-owner/non-superuser/NOBYPASSRLS. It grants EXECUTE on exactly two mutation functions, not direct INSERT/UPDATE/DELETE on tenant tables. The functions have pinned trusted search paths and no dynamic SQL; their default PUBLIC execution grant is revoked in the same migration transaction. The schema/migration owner is also a non-superuser/non-BYPASS role, held in root-only credential files.

An owner-specific RLS policy supports these narrow SECURITY DEFINER commands. Its executor check compares the current SQL role to the actual household-table owner, not any user-settable GUC. Runtime cannot make the check true by selecting a household or setting a session parameter. Existing runtime read policies still depend on verified subject/current local membership and transaction-local household context. Unexposed relationship/consent tables remain denied. Runtime DB credentials are a trusted backend boundary; this is not a promise of tenant isolation after compromise of the Instance runtime/its command credentials.

Readiness now requires every migration in the running component manifest, preventing a command-enabled runtime from declaring ready against only its first migration. Existing applied checksums are unchanged. Backups use the distinct read-only BYPASSRLS role, including receipt/outbox tables. Code rollback leaves additive schema/receipts in place; it is not a database rollback.

## Created and departed state

Creation stores the user-authored name in the Instance database, adds exactly one active technical owner membership and records an explicit free pilot entitlement snapshot at version 1. No commercial quota numbers are selected here. Invitations/public creation must add atomic quota reservations in #53 before being exposed. No relationship, dynamic role, agreement acceptance or consent record is created implicitly.

Any active participant can leave without another person's approval, including a technical owner. The transaction marks only that membership left and increments the household safety version. If no active members remain, the household closes. If members remain without an owner, it pauses without removing them or automatically assigning ownership. Existing owners keep the previous safety status; leaving never resumes a pause. An owner-recovery/voluntary transfer workflow and relationship-scoped safety handling remain later acceptance. A paused group can still be read by its remaining members and they can leave.

Departure is logical membership revocation, not account deletion, household deletion, data erasure or consent transfer. The existing summary API immediately denies the departing account even if a central routing hint remains stale. Browser-accessible local leave and the valid-local-session/manager-outage path still need integration; the current signed command transport is not that complete availability solution.

## Audit and outbox

Each successful operation records an actor account, household/resource UUID, semantic event key, timestamp and operation UUID. Shared audit parameters contain only the operation UUID: no household name, relationship/limit text, request body, JWT, invite token, upstream URL or credential. Audit and outbox are protected and have no public reader in this checkpoint. This is not cryptographic tamper-proof logging or an undo API.

The durable outbox contains minimal household/account/operation/event metadata and a delivery marker. A reliable dispatcher, central acknowledgement/reconciliation, retry/retention policy, authorized activity UI and personal/shared audit access remain #12/#18/#26/#58. Do not mark entries delivered merely because the private API returned HTTP 200.

## Evidence and remaining gates

Unit tests cover token scope/body/expiry/read-write separation, strict routes/body bounds and redacted failures. Native PostgreSQL/HTTPS tests cover concurrent operation deduplication, conflicting actor/target/action/body, exact-token replay, failed-outbox rollback and retry, non-owner runtime permissions, four-person departure/ownerless pause, immediate membership denial, final-member closure, no automatic consent and backup reads. Live deployment/pilot acceptance remains operator-observed through update.sh; no remote server was changed by a source commit.
