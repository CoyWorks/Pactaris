# Maintenance and retention

Owner decision, 21 November 2026: technical records that are only needed for a while are cleaned up automatically, and operators can see and start the cleanup from the **Maintenance** tab of the operator console. Cleanup never removes what people wrote in their dynamics; personal data goes only through leaving a dynamic or deleting an account.

## What is removed, and when

| Where | What | After |
| --- | --- | --- |
| Instance | Operation receipts of tasks, approvals, proof, points/punishments, requests, consent, relationships, library, catalog, routines and the workspace, with their write-only outbox rows. A receipt only makes an exact retry of the same request return the first answer. | 90 days |
| Instance | Read notices and read task notices (unread ones stay). | 90 days |
| Instance | Used request tokens (`delegation_uses`). | When expired |
| Instance | Proof files on disk that no database row explains (after a crash or a database restore). Files younger than an hour are left alone, so an upload that is still committing is never touched. | Daily |
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

## Later

- Server housekeeping (backup and release retention, npm cache, unused Identity images, journald limits).
- Purging dynamics that everyone left, 30 days after the last member left.
