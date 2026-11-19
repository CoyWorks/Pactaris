# Rules/protocol library and notes — 0.9.0-alpha.1

Connected everyday slices of #16/#66. A sole owner can prepare rules, protocols and notes before inviting anybody. It also supports explicit reading assignments on a published rule or protocol.

## Authoring and explicit publication

The workspace has separate Rules/protocols and Notes/ideas sections. Items have original user-authored title/text/category and a numeric order (lower first). Private drafts are the default. Within each kind, visible results are ordered by `(position, documentId)` with ten bounded summaries per page; full text is fetched separately. A title/category/body search applies the same current visibility as detail/list. Queries travel in authenticated POST bodies, never app-generated URLs or audit parameters.

Any active member can create and manage their own items, not somebody else's. An owner/admin is not automatically the author of another person's content and cannot override its private visibility. Creating a rule does not give its author authority over other members. All items start as author-only drafts, even if a future audience is configured. Publication is a separate reviewed action with the exact current version.

Audience choices are only the author, up to eight specifically selected current membership UUIDs, or all current/future household members. The author is implicitly included and cannot be added as a selected recipient. Selected recipients are validated in the same household both on save and again on publication; leave/rejoin requires a new explicit selection. Household-wide sharing deliberately includes new members, which the interface explains.

All text is plain text rendered as escaped React content, preserving line breaks. Title <=120, text <=2,000 and category <=60 characters, order 0–999999. The total private request remains limited to 4096 bytes, so Unicode-heavy text can reach that earlier. No executable markup, CSS, attachments or rich editor is added. These are technical alpha bounds, not a premium relationship/privacy restriction.

## Versions, acknowledgement and lifecycle

Each saved edit or lifecycle change creates a new monotonic saved version. Editing a published item makes the new head a private draft and immediately withdraws reader access until explicit republication. Earlier versions/acknowledgements are not copied forward. This intentionally simple workflow does not serve a stale published copy alongside a draft branch. Authors can browse earlier saved snapshots; other readers can access only the currently published authorized version, never the author's earlier private history. Newly added audiences do not inherit historical access.

Published rules/protocols can be explicitly acknowledged by the current member for the exact current version. Reading, login, publication and invitation acceptance never acknowledge automatically. Acknowledgement records having read that text, not consent, agreement to perform an activity, technical permission or an activity assignment. Notes cannot be acknowledged. Current author and reader acknowledgement displays remain separate: a reader sees only their own record; an author can inspect records for still-active acknowledging memberships on their item/version, including permitted historical snapshots. Up to twenty rows are displayed with an explicit more-results notice; extended browsing remains later. Minimal records for ended memberships are retained in the database but not exposed in this roster.

Archive withdraws sharing and blocks new acknowledgement. Restore creates a private draft; it does not republish. Rules/protocols retain version/acknowledgement history through archival. Only notes support deletion in this slice: the author's explicit confirmed action removes its saved text versions from the live Instance database and retains a minimal deleted document marker/receipts/audit without the text. Retrying an old creation receipt does not resurrect it. Backups, previously viewed copies and trusted off-host erase/revocation replay are separate #25/#26 gates; this is not a claim of global or backup erasure.

A departing/removed author's draft/published items archive atomically and stop being shared. They remain tied to that ended membership UUID. Rejoining restores neither authorship, private content, selected-share access nor receipt authority. This avoids silent ownership transfer of intimate notes. Full retention/export/deletion policy for ended accounts remains separate work.

## Authorization and transactions

One reviewed current-visibility predicate covers list/search/detail/acknowledgement. Drafts/archives are author-only; published content requires the author or the authorized current audience. Historical read additionally requires original authorship. Wrong tenant/Instance, ended membership, unrelated admin, proxy actor inputs and noncurrent selected recipients fail closed. The manager keeps placement/operation transport only, not note/protocol bodies or search terms. Public projections expose only allowed document/membership identifiers, not global account IDs, IdP subjects/emails or backend endpoints.

Narrow SECURITY DEFINER operations run behind FORCE RLS, exact-generation membership, body/purpose/audience-bound signatures, replay protection, shared household lifecycle locking and optimistic versions. Runtime/backup cannot call the private visibility helper as a public data oracle; runtime has no direct document table grants and backup stays separately protected/read-only. Every mutation commits domain state, audit, receipt, outbox and replay atomically. Failures roll them all back, including note deletion. Exact same-operation/body retries return only historical acknowledgement; changed payloads conflict and cannot restore an archived/deleted item.

Publishing/reading/acknowledging descriptive guidance is not protected task execution, so it does not require a fabricated partner relationship or override any pause/consent state. No job, assignment, reward or consequence is executed. Future protocol/task references must recheck current published state/version, technical/resource rights and applicable activity consent/safety under the same effect transaction. No automatic assignment or queue integration is claimed.

## API and frontend behavior

- `GET /api/households/:householdId/library?kind=rule|protocol|note&filter=active|archived&after=POSITION:UUID` lists current visible summaries without search text in the URL.
- `POST .../library/documentList`: operationId, kind, filter, query and optional after. This is the nonmutating search/list contract.
- `POST .../library/documentRead`: operationId, documentId and optional version (historical snapshots are author-only).
- `POST .../library/documentCreate`: operationId, kind, fields.
- `POST .../library/documentUpdate`: operationId, documentId, version, fields.
- `POST .../library/documentPublish|documentArchive|documentRestore|documentDelete|documentAcknowledge`: operationId, documentId, version.

Fields have exactly title/body/category/position/visibility/recipients. Actor membership is resolved privately; the browser cannot nominate an acknowledger or another Instance. Mutations require gateway session, exact Origin/CSRF and account throttling. Read-only POSTs retain Origin/CSRF checks but do not consume the write bucket. Fresh operation IDs protect signed reads from replay; no read/audit row persists private search text.

Visible online sections refresh once per minute plus explicit user actions, with deadlines/cancellation. Permission failures clear an open detail; refreshed lists discard details/confirmations whose current version is no longer on that page. Previously viewed copies cannot be remotely erased. Unknown writes retain an exact in-memory retry draft; there is no offline mutation queue, automatic retry, localStorage persistence or success claim after a timeout. Archive/delete/publish have explicit confirmation. Plaintext editor buffers are transient and discarded on module/household navigation.

## Verification and preserving updates

Targeted tests cover strict keys/versions/audience, UUID normalization, multiline text and separate keyed notes/guidance controls without preacceptance. Native PostgreSQL/two-Instance HTTPS coverage includes solo preparation, privacy against admins, author-only history, selected/household publication, new-version acknowledgement, note deletion/no resurrection, visible-only search, bounded ordered pagination, tenant/Instance/CSRF boundaries, archive/restore and acknowledge/edit or publish/archive races, selected-recipient membership generation, final-outbox deletion rollback/replay, runtime/backup restrictions and author departure/rejoin.

Migration `instance/0010_library_notes` is additive. Preserve prior checksums, independent schemas/config/secrets, runtime/migrator/read-only backup separation and Identity issuer/client/flows/Brand/web certificate/TLS/domain/proxy settings. The normal updater installs Instance before gateway; no extra operator configuration is required. Application fallback does not undo migrations or legitimately restore deleted/sharing-revoked data. Native CI and live operator/mobile visual acceptance are separate evidence; a source push does not deploy the server or certify full export/restore/attachment paths.

Next everyday work is habits (#63) and ritual/check-in definitions (#19), followed by reward catalog preparation (#64). Broader task sharing/review, reminders/notifications, files, complete audit/export filtering and privacy/operations launch gates remain open; do not describe a completed library slice as a completed broad parent issue.

## Reading assignments

Authors can assign the currently published rule or protocol to up to eight current members who can already read it. Members see only their own assignment. The author can remove an assignment, and publishing a new version requires a fresh assignment. Archival and membership changes end active visibility. Reading assignments do not grant access or record acknowledgement, and no external notification or task is created.
