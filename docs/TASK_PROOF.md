# Completion proof (photos)

A sub can attach a photo as proof before submitting a shared task. Proof is **intimate content on a kink platform**, so the design is privacy-first: the bytes live only on the instance's own disk, metadata-stripped and encrypted at rest, reachable only by the people who approve the task, seen at most once by each of them, and deleted soon after.

Owner decisions:

- 20 November 2026: store bytes as **files on the instance**, not in the database, behind a storage abstraction, with app-layer AES-256-GCM encryption. A cloud blob store reachable only from gateway, identity, instance or proxy can replace the backend later without touching the rest.
- 21 November 2026: a submitted task is approved by several people (see [HOUSEHOLD_AUTHORITY.md](HOUSEHOLD_AUTHORITY.md#approval-by-several-people)). The photo is visible to **every approver of that round** and is deleted **once each of them has seen it once**, and at the latest 48 hours after submission.

## Threat model and principles

- Only the assignee (the author) and the approvers of the round the photo was submitted with may open it. Household administration grants no access.
- Instances are private infrastructure; a proof never has a public or direct-to-storage URL. Bytes move browser → gateway → instance over the signed command channel and come back the same way. The gateway keeps nothing.
- Operators never receive household content, proof included. Abuse reports act on accounts and households, not by viewing images.
- A stolen disk must not expose images: encryption at rest with a per-instance key readable only by root and the service group, like the other runtime secrets.
- Location and other EXIF/XMP metadata must not leak: the browser re-encodes the photo (at most 1600 px, JPEG) and the instance strips metadata again before storage.
- Screenshots cannot be prevented; the viewer says so.

## Lifecycle

| Step | What happens |
|---|---|
| Upload | Only the assignee, while the task is assigned, accepted, in progress or sent back for changes. One unsubmitted photo per task: a new upload replaces the previous one. An unsubmitted photo expires after 7 days. The author can remove it. |
| Submit | The latest unsubmitted photo is bound to the new approval round and expires 48 hours later. Each approver of the round gets one view. |
| View | An approver opens it once. The view is recorded only after the whole image reached the browser, so a failed download does not use it up. The author can open their own photo while it exists. |
| Deletion | The bytes go once every approver has seen it, when anyone asks for changes (the round ends), when it is removed, when it expires, or when the author or any approver leaves or erases their account. The worker deletes the files; the metadata row stays without bytes. |

Proof files are **not part of any backup**: they live for at most 48 hours after submission and are deliberately left out. A restored database can list a proof whose file is gone; opening it then answers "no longer available".

## Components

- **Store** (`apps/instance/proof-store.ts`): magic-byte type check (`image/jpeg`, `image/png`, `image/webp`), max 5 MB; metadata strip in pure JS (JPEG `APPn`/`COM`, PNG `eXIf`/`tEXt`/`zTXt`/`iTXt`/`tIME`, WebP `EXIF`/`XMP `); AES-256-GCM with a random IV, file layout `IV|tag|ciphertext` over `type-index|image`; files at `<storage.root>/<householdId>/<proofId>` (dirs `0700`, files `0600`). `prepare` validates and strips without touching the disk; `write` never overwrites an existing file. A full re-encode on the server (e.g. `sharp`) is deferred to avoid a native dependency.
- **Schema** (`0044_task_proofs`, `0045_task_approvals`): `task_proofs` (with the bound `round`), `task_proof_views` (one row per approver), `proof_receipts`, all FORCE RLS. `proof_command` actions: `proofPut`, `proofHead`, `proofViewed`, `proofRemove`, `proofList`; `proof_sweep` and `proof_mark_purged` for the worker. `partnerRead` and `approvalRead` include the proof state for the caller (`available`, `consumes`, `expiresAt`).
- **Transport**: household actions `proofUpload`, `proofView`, `proofViewed`, `proofRemove`.
  - Upload: the gateway signs a command whose body is one JSON header line (`operationId`, `membershipId`, `taskId`, `type`), a newline, then the image; the signature's `body_sha256` covers both. The instance route `…/commands/proofUpload` accepts up to 5 MB plus the header; every other command stays at 4 KiB.
  - View: `proofView` returns the image bytes without consuming the view; after the response finished, the gateway sends `proofViewed`.
- **Gateway routes**: `POST /api/households/:id/participant-tasks/:taskId/proof` (raw image body, `X-Operation-Id`, CSRF, throttled), `POST /api/households/:id/proofs/:proofId/view` (a POST with CSRF so a cross-site link cannot use up a view; `Cache-Control: no-store`), `POST /api/households/:id/proofs/:proofId/remove`.
- **Configuration**: `storage.root` and `storage.keyFile` in the instance config. The deployer provisions `secrets/proof.key` (generated once, kept across updates) and `data/proofs` when the section is absent; an operator-chosen section is left alone. Without `storage`, proof answers `unavailable` and everything else works.
- **UI**: the assignee adds, replaces or removes a photo in the task detail before submitting; approvers open it from their approval view or the task detail, with a one-time warning.

## Operator note

The public proxy must accept request bodies of about 6 MB on the product origin for uploads. The browser normally sends far less after re-encoding, but a browser that cannot re-encode sends the original file.

## Later

- A Dom-side "proof requested" flag on a task.
- Proof on habit records.
- A cloud blob backend behind the same store interface.
