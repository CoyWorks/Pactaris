# Maintenance and retention

Owner decision, 21 November 2026: technical records that are only needed for a while are cleaned up automatically, and operators can see and start the cleanup from the **Maintenance** tab of the operator console. Cleanup never removes what people wrote in their dynamics; personal data goes only through leaving a dynamic or deleting an account.

## What is removed, and when

| Where | What | After |
| --- | --- | --- |
| Instance | Operation receipts of tasks, approvals, proof, points/punishments, requests, consent, relationships, library, catalog, routines and the workspace, with their write-only outbox rows. A receipt only makes an exact retry of the same request return the first answer. | 90 days |
| Instance | Read notices and read task notices (unread ones stay). | 90 days |
| Instance | Used request tokens (`delegation_uses`). | When expired |
| Instance | Proof files on disk that no database row explains (after a crash or a database restore). Files younger than an hour are left alone, so an upload that is still committing is never touched. | Daily |
| Instance | Dynamics everyone left: closed when the last member leaves (or, if that was missed, when the daily run finds no active member), and purged 30 days later. Every row in every table with a `household_id` is deleted, plus the dynamic's proof folder. A tombstone (ID, instance, closed and purged times) and the content-free revocation journal stay. | 30 days after closing |
| Gateway | Placements of purged dynamics are disabled (kept as routing history). | Next daily run |
| Gateway | Expired rate-limit counters. | 1 hour after reset |
| Gateway | Finished or rejected membership operations. | 90 days |
| Gateway | Closed reports and their notes. Open reports are never removed automatically. | Setting, default 365 days (30 to 3650) |

Kept on purpose: household audit events (who paused, stopped or withdrew), membership, invitation and household-command receipts (the gateway reconciles against them), onboarding operations (they count towards the owned-household limit), and the operator audit log.

Run history is kept for a year on both sides.

## How it runs

- The instance worker calls `run_retention` and the proof-file sweep at most once a day (migration `0046_retention`). The gateway worker trims its own records at most once a day (migration `0025_maintenance`).
- The console reads each instance's recent runs, largest tables and proof storage through the instance-scoped signed channel (journal actions `maintenanceStatus` and `maintenanceRun`); an unreachable instance is listed as such.
- **Preview** counts what would be removed without changing anything; **Run now** is enabled after a preview. Operator runs are recorded in the operator audit log (`maintenance.run`).
- A failing run logs `maintenance.deferred` and is retried on the next worker tick.

## Dynamics everyone left

Not purged: dynamics that still have members, including those without an owner (the console shows how many), and dynamics with one member. Former members lose the part of their personal export that came from a purged dynamic; they can export within the 30 days. Backups keep the content until they expire under the backup retention. The purge function finds the tables by their `household_id` column, so tables added later are covered; the integration test checks that nothing of a purged dynamic is left in any of them.

Server housekeeping (checkpoints, releases, caches, journal) is described in [SERVER_HOUSEKEEPING.md](SERVER_HOUSEKEEPING.md).
