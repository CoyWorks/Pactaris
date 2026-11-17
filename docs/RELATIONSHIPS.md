# Private relationship proposals — 0.6.0-alpha.1

This implements a scoped #35/#9 graph workflow. It does not complete the broader consent, safety, profile or resource-permission issues.

## Participation and roles

Any active member may propose a relationship including themselves and 1–7 other current members of the same household. Proposals contain a user-authored name/type, description and up to eight contextual role assignments. Each assignment has a participant, a free-form label, an optional specific counterpart and context. Several roles may belong to the same person. No pairwise connection, exclusivity, rank, technical permission or consent to an activity is inferred. There is no commercial restriction on relationship forms or role diversity.

The limits bound this alpha's command payload and response size; they are not paid-tier limits. The private request remains limited to 4096 bytes. A Unicode-heavy proposal may reach that byte limit before the character limits. The member picker currently offers the first twenty current members; larger-household picker/search remains future work.

Submitting does not accept anything, including for the proposer. Every named person separately accepts their own participation. Only unanimous acceptance activates the proposal. Any pending participant can decline; any named participant can withdraw from a pending or active relationship. Either action ends the whole proposal/relationship. Other participants cannot override that decision. A paused household blocks new proposals and acceptance but not decline or withdrawal. Relationship decisions never resume a household or clear a safety state.

## Exact proposal and history

Each relationship ID identifies an immutable version-1 description, participant set and role snapshot. Acceptance requests must name that ID and version. Editing an existing proposal is intentionally unavailable: propose a new relationship and obtain fresh individual decisions. No acceptance is copied, and the older relationship is not automatically ended or replaced. Participants must explicitly withdraw from the older relationship if that is their intention.

These are relationship-description decisions, not negotiated activity consent. Versioned limits, safety signals, personal pause/stop, agreements, sessions and protected task/protocol execution remain #10/#11 and later modules. An active graph edge must never authorize a task, play or consequence by itself. Optional global preference labels and advanced relationship type editors are also not shipped here.

Leaving/removal ends every pending or active managed relationship containing that precise membership UUID in the same transaction, and records that participant as withdrawn. Other participants can still view the permitted historical snapshot. The departing membership's alias is cleared by the existing lifecycle hook. Rejoining gets a fresh UUID and inherits no graph access, roles or decisions. Legacy scaffold-only rows are preserved but not exposed or silently converted into accepted proposals.

## Privacy and authorization

All relationships in this slice are participants-only, including proposals, lists, roles, decisions and history. There is no household-wide sharing switch. Owner/admin, dynamic roles, billing and instance operators do not confer participant access through the application API. A technical admin can be a sub/bottom; a Dom can be a technical participant. Household membership alone does not reveal another group's graph, count or labels.

The runtime has no direct grants on graph, receipt or outbox tables. FORCE RLS permits only the schema owner executing reviewed SECURITY DEFINER commands; narrow runtime EXECUTE grants expose live-membership-checked operations. Separate migration and read-only backup credentials remain unchanged. Operator database access is not end-to-end encryption.

Responses contain only relationship and membership IDs, household-local aliases, user-authored proposal fields and individual decisions. No global account IDs, IdP subjects, emails, private Instance endpoints or other households' records are returned. Future audit/export/search/file APIs must enforce this same participant policy; this release does not implement those APIs or claim their broader issues complete. Minimal audit/outbox entries contain operation/resource identifiers, never proposal text or role labels, and have no general public feed in this slice.

## Public and private contracts

- `GET /api/households/:householdId/relationships?after=UUID` lists one visible relationship per page. The cursor considers only the requesting membership's visible rows. A fresh read reports current state.
- `POST /api/households/:householdId/relationships/propose` accepts exactly `operationId` and `proposal` (`label`, `scope`, `participants`, `roles`).
- `POST .../accept`, `.../decline`, `.../withdraw` accept exactly `operationId`, `relationshipId` and string `version: "1"`.

Mutations require the current gateway session, exact configured Origin, CSRF token and account throttling. The gateway resolves the current membership privately; the browser cannot nominate an actor, accept for somebody else, change visibility or select an Instance. Manager storage receives no graph content. Private commands use distinct purpose/method/path/household/Instance/body-bound signatures, 30-second lifetimes and replay rejection.

Instance transactions serialize with membership/household lifecycle commands and atomically commit graph changes, minimal audit, receipt, outbox and replay marker. Identical requests with the same operation ID return a minimal historical acknowledgement; changed inputs conflict. Acknowledgements do not assert that a relationship is still active. Current membership is checked even before returning an old receipt. A failed transaction permits retrying its identical signed packet because the replay insert rolls back too.

There is no central durable graph queue or automatic redispatch. After a lost acknowledgement the page retains the exact operation/details in memory for explicit retry, using a fresh signature and the Instance receipt. Refresh can show current state without repeating a command. Leaving/reloading the page discards that local retry draft; no intimate content is put in localStorage or the manager database. A timed-out request is unconfirmed, not a reported failure or success. General outbox delivery remains open.

The page polls at most once per minute while visible and online, with bounded requests and cancellation on navigation. User actions may trigger an immediate refresh. No Web Push delivery or offline mutation queue is added.

## Verification and rollout

Targeted input tests cover contextual overlap, strict body/version validation, proxy-authority injection, duplicate UUID casing, counterpart membership and canonical retry hashes. The real PostgreSQL/two-Instance HTTPS fixture exercises public proposal/decision flows, a pair/four-member group, contextual switching and romantic overlap, participant-only pagination, admin exclusion, tenant boundaries, lost replies, decline, withdrawal while paused, accept/withdraw races, removal/rejoin fencing, rollback/replay and runtime/backup restrictions. Passing CI must be observed separately from live operator/mobile acceptance.

Migration `instance/0007_relationships` is additive; existing migration checksums remain intact. The normal preserving updater installs the Instance before the gateway. There is no new configuration or Identity change. Preserve issuer, client, flows, Brand/web certificate, secrets, domains, databases and backup credentials. Application fallback does not undo a migrated database or restore an ended relationship. Full deletion/retention/export and trusted off-host restore revocation gates remain open.
