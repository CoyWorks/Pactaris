# Personal reward catalog preparation — 0.11.0-alpha.1

First owner-only preparation slice of #64. A household with just its creator can create, edit, order, archive and restore private reward drafts. No partner, relationship, agreement, points balance or scheduler is required to prepare an idea. This does not complete #64 or implement the ledger in #20.

## Content and states

A reward draft has a title (120 characters), optional description (500), category (60), order (0–999999) and optional proposed non-monetary point cost (whole numbers 0–1000000). Empty cost means unconfigured; explicit zero is distinct. These are technical input bounds, not paid-plan decisions. User content stays in the Instance database; visible system text uses keyed English messages and point values use the selected formatting locale.

Every create/edit/archive/restore saves an immutable content version. Existing versions retain their original fields and proposed cost. The author can browse prior versions; historical views display the current item's lifecycle state with a historical marker and cannot mutate the old snapshot. Editing requires the current optimistic version. Restore returns to a private draft. No publication, redeemable offer, consent, point grant/debit/reservation, consequence or fulfillment is created. Sharing, agreed consequences and redemption are later reviewed slices.

## Privacy and preparation

Each item belongs to the exact membership that created it. Another owner/admin cannot list/read/edit it or browse its saved versions. All active members may prepare their own private catalog, including while household/personal activity is paused. Preparation does not clear a pause, override a limit or authorize activity. A closed household rejects access. Membership departure archives its current drafts and saves a new version inside the existing lifecycle transaction; rejoining never restores private history or old receipt authority.

Catalog lists are capped at 10 items, ordered by explicit position then UUID with a validated cursor. Concurrent reordering can change page membership; pagination is not an immutable full-catalog snapshot. The UI polls only while visible/online at a 60-second interval, refreshes after mutations and retains one uncertain write in memory for exact retry. It does not claim offline success, persistent retries, notifications or push delivery. Detail views remain pinned until reopened; stale edits fail with a refresh/review conflict.

## API and database boundaries

`POST /api/households/:id/catalog/:action` supports catalogList/catalogRead/catalogCreate/catalogUpdate/catalogArchive/catalogRestore. Every POST requires the current browser session, exact origin/CSRF and strict public input. Browser input cannot supply membership/creator/Instance authority. The gateway obtains live local membership and signs exact-purpose, method/path/body/Instance/household delegations; it stores no catalog content.

Additive Instance migration 0012 creates items, immutable versions, command receipts, a durable outbox and departure archival. Runtime has only a narrow command grant, with FORCE RLS on tables; separate backup credentials remain read-only. Shared household lifecycle locking serializes membership changes, and exact operation receipts, audit metadata, content and replay consumption commit or roll back together. An uncertain retry cannot create duplicate items or silently reuse an operation for changed content. Outbox rows are durable event records, not delivered notifications or a running reward engine.

## Update and verification

Use the existing preserving updater; Instance must activate before gateway. No new operator input, Identity change, domain/TLS/proxy change or credential reset is required. Preserve prior migration checksums and runtime/migration/backup separation. The production/test build separation and reduced-stack compiler regression from #72 remain in place; code fallback does not undo migrations or recreate departed authority.

Local tests cover exact input/identity/version/cursor validation, zero/null/cost bounds and keyed private UI. Native PostgreSQL/HTTPS acceptance exercises one-member setup, content/version persistence, idempotency/conflicts, unrelated-admin and tenant/Instance/CSRF boundaries, paused preparation without safety changes, pagination, optimistic races, failed-final-outbox rollback/replay, read-only backup/runtime denial and departure/rejoin fencing. Real operator/mobile acceptance remains separate from CI.

Next scope: explicit sharing/publication and request/review/fulfillment/cancel/reversal with the consent-aware non-monetary ledger (#64/#20). Partner task flow #17 remains a separate priority. Full export/deletion/retention and trusted off-host restore replay are still open privacy gates.

## Catalog selection in task planning

The participant-task editor can attach a current version of one of the creator's own reward drafts to an offer, a direct assignment or a series. The Instance binds the selection to the same household, actor membership and exact catalog version before writing the task. It snapshots the title and terms. Later catalog edits do not change previously assigned tasks; scheduled occurrences retain the selected terms. Only task parties can open the attached snapshot, and the recipient does not receive the source catalog reference.

Attaching terms is a proposal. It does not automatically grant the reward, initiate redemption, charge points or alter existing consent checks. The separate optional reward-points field keeps its existing review and policy behavior. Redemption and fulfillment remain follow-up in #64.

## One-time habit reward

When offering a point grant, the issuer can require a completed private habit goal. The recipient explicitly chooses one of their own active daily or weekly minimum-goal habits and claims the offer. The Instance checks unreversed progress in the habit’s current timezone-based period, the exact habit and offer versions, points settings and the current reward agreement before applying one ledger credit. The issuer sees the offer and its fulfillment, with the habit identity, title and progress visible only to its owner. Either party can cancel before fulfillment. Progress corrections after fulfillment leave the original credit in the ledger. The issuer can record a linked reversal. Missed goals have no effect and the offer expires on its normal schedule.
