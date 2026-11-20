# Completion proof (photos)

A sub can attach a photo as proof when submitting a shared task (and, later, a habit record). Proof is **intimate content on a kink platform**, so the design is privacy-first: bytes live only on the instance's own disk, metadata-stripped and encrypted at rest, reachable only by the two people the task is between, and removed on departure or erasure.

Owner decision (20 November 2026): store bytes on **instance-local disk** behind a storage abstraction, with app-layer AES-256-GCM encryption. Object storage can replace the backend later without touching the rest.

## Threat model and principles

- Only the task's **creator (Dom) and assignee (sub)** may view a proof. Household administration grants no access.
- Instances are private infrastructure; a proof is never a public or direct-to-storage URL. Bytes move gateway → instance over the existing signed channel and are streamed back through the gateway.
- Operators never receive household content, proof included. Abuse reports act on accounts/households, not by viewing images.
- A stolen disk or backup must not expose images: encryption at rest with a per-instance key held root-only, like the migration/backup credentials.
- Location and other EXIF/XMP metadata must not leak: metadata is stripped before storage.

## Storage module — `apps/instance/proof-store.ts` (slice 1, done)

- **Validation**: type is sniffed from magic bytes (`image/jpeg`, `image/png`, `image/webp`); a declared type that disagrees is rejected. Max 5 MB, non-empty.
- **Metadata strip** (pure JS, no native dependency): JPEG drops every `APPn` (incl. EXIF/XMP in APP1) and `COM`; PNG drops `eXIf`/`tEXt`/`zTXt`/`iTXt`/`tIME`; WebP drops `EXIF`/`XMP ` and rewrites the RIFF size. Structural/image data is preserved.
- **Encryption**: AES-256-GCM, random 12-byte IV, 16-byte tag; the file is `IV|tag|ciphertext`. The authenticated plaintext is `type-index|clean-image`, so a wrong key or any tamper fails closed (`proof.corrupt`).
- **Layout**: `<storage.root>/<householdId>/<proofId>`, dirs `0700`, files `0600`, written to a temp file then renamed. `delete` and `deleteHousehold` remove them. IDs must be UUIDs (no path traversal).
- A full re-encode (e.g. `sharp`) would harden against polyglots further; it is deferred to avoid a native dependency. Magic-byte validation + container stripping + GCM authentication is the alpha baseline.

## Remaining slices

**Slice 2 — transport, metadata and access control**
- Config: add `storage.root` (absolute dir) and `storage.keyFile` (root-only 32-byte hex key) to `InstanceConfig`; update the config parser, fixtures and the install/update scripts to provision the directory and key and to include the directory in backups.
- A metadata table `task_proofs(household_id, id, task_id, author_membership_id, type, size, sha256, created_at)` under FORCE RLS, with a `SECURITY DEFINER` command that: authorizes a put (the author must be the task's assignee and the task in a submittable state), authorizes a get (creator or assignee only), lists a task's proofs, and deletes. Hook departure and account erasure to delete the member's proofs from disk (the command returns the ids/households to purge, or a worker does).
- Binary endpoints with a new signed purpose `instance.proof.put`/`get` (separate from the 4 KB command path): gateway `POST /api/households/:id/participant-tasks/:taskId/proof` (raw body, hashed and length-checked) and `GET …/proof/:proofId` (streamed, `Cache-Control: no-store`, strict `Content-Type`, under the existing `img-src 'self'` CSP). The instance validates via the command, then the store put/get.
- Integration tests on the real stack: put as the assignee, get as both parties, denial for a third member and for an unrelated household, type/size rejection, and purge on departure/erasure.

**Slice 3 — UI and polish**
- On the task submit form, an optional photo (camera/upload), shown only to the two parties in the task detail. A sub can remove their own proof.
- A Dom-side option "proof requested" on a task so the submit note/photo is expected.
- Retention: proof removed when the task is deleted/archived; optional max age.

## Why phased

Slice 2 touches deployment (new directory and secret, backups) and adds binary transport, and the content is sensitive. Landing the verifiable storage core first, then the transport and access control with full integration coverage, keeps each step reviewable and testable rather than shipping a large, partly-unverifiable change at once.
