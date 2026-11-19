# Personal habits, rituals and check-ins — 0.10.0-alpha.1

First owner-only slice of #63 and #19. It adds everyday content to the existing household workspace without requiring another participant, relationship, agreement or reviewer. These parent issues remain open for their wider criteria.

## Available behavior

Today shows up to four active habits with a **+1** button, and the add sheet can create and start a daily habit in one step (two explicit commands: create, then activate). Both use the same commands, checks and privacy as the Routines section; see [MOBILE_LAYOUT.md](MOBILE_LAYOUT.md).

- Habits: private draft definitions with title, description, category, IANA timezone, daily/weekly periods and a minimum/maximum target count. Explicitly activate a draft before recording personal progress. Multiple timestamped entries contribute to each period's total.
- Rituals: private daily/weekly or single-date definitions with an explicit personal completion confirmation. Check-ins: the same calendar periods with text, 1–5 rating or yes/no response. A period accepts one unreversed ritual/check-in response; reverse it before replacing it.
- Editing creates a saved configuration revision and returns to draft. Prior revisions retain their own progress/history; lifecycle pause/resume does not reset a revision's totals. Archive, restore to draft and manual pause are available. There is no automatic reactivation or missed-period backlog.
- History selects a calendar date and definition revision, with bounded entries and visible reversals. Reversal excludes the original entry from totals while preserving its original text/timestamp as history. It also works on archived/historical content during a pause. No points, rewards or consequences are issued.

## Time and state

All period calculation runs in one Instance calendar helper, shared by these three definition types. Weeks start Monday. Local midnight boundaries are converted separately through the definition's IANA timezone, so daylight-saving days may have 23 or 25 hours. There is no fixed-24-hour recurrence or scheduler in this slice. The next read computes the relevant period; it creates no jobs.

An omitted entry timestamp means server time. A manually selected timestamp uses the device's local timezone and is displayed in the definition's timezone. The selected history date is a viewer, not an implicit backdated write: choose an explicit entry time for a prior period. Future entries and entries more than 90 days in the past are rejected; older saved history remains readable. Single-date definitions accept entries only within that configured local day. Changing a timezone/period/target creates a new configuration revision instead of rebucketing historical entries.

Maximum goals are descriptive totals, not a promise of compliance or a trigger for punishment. Empty/missed periods have no automatic outcomes. Scheduled vacations/custom periods remain open #63/#18 work.

## Privacy and safety

Everything in this release is personal-private, bound to the exact active membership that created it. The UI states this. Another household administrator cannot read definitions, responses, categories or history. There is no sharing, reviewer access, partner assignment or implicit all-to-all visibility. Departure archives that membership's content in the existing membership transaction; a later membership never inherits it.

Habit/ritual activation and progress enforce the current household state, personal pause, both safety epochs and the actor's structured task/protocol blocks. An old request remains stale after a pause/resume cycle. Private check-in reflection is deliberately still available during a household/personal pause; submitting it never resumes a routine, household or member, clears a block or grants consent. A manually paused or archived check-in still rejects new responses. Draft editing/reads and progress correction do not require another person's approval.

## API and storage

Browser routes stay at the canonical product origin: `/api/households/:id/routines` for bounded lists and `/api/households/:id/routines/:action` for explicit signed commands. Origin/CSRF protects every POST, including reads; user input cannot choose membership, Instance or creator authority. Writes use operation receipts for exact retries, transaction-bound JWT replay consumption, audit metadata and a durable outbox. Uncertain browser writes retain one in-memory request for retry; there is no offline success or persistent replay queue. Visible online screens poll at most once per 60 seconds, with immediate refresh after user actions. No push delivery or reminder worker is claimed.

Additive Instance migration 0011 stores definitions, saved revisions, timestamped progress, receipts and outbox rows. FORCE RLS and a narrow command grant protect content; runtime cannot directly read the tables or execute the calendar helper. Backup credentials remain read-only and separate. The gateway stores no definition/response content. Lists return at most 10 definitions and 3 progress entries per page, ordered by opaque UUID cursors; totals cover the entire selected period. Event display order is not a chronological feed.

## Rollout and checks

Use the normal preserving updater; activate Instance before gateway. No new operator configuration, Identity changes, secrets, proxy edits or TLS changes are needed. Earlier migrations/checksums remain intact. Application fallback does not undo the additive schema or restore withdrawn authority.

Local validation covers strict input, keyed owner-only screens, translations/build and branch-cleanup safety. Native PostgreSQL/HTTPS CI covers daily/weekly/single-date periods, DST, duplicates/reversals, revision history, paused reflection, stale safety epochs, concurrent writes, private administrative boundaries, CSRF, transactional rollback/replay, role separation and departure/rejoin fencing. Live mobile/operator acceptance is a separate gate.

## Remaining scope

Custom periods, scheduled breaks, partner assignment/review/sharing, reminders/job scheduling, Web Push, charts, exports/retention/deletion and agreed outcomes remain open under #18/#19/#20/#22/#23/#29/#41/#63. The next everyday feature is private reward catalog preparation #64, without automatic grants or consequences. No paid/free quota decision is introduced here.

## Private habit count chart

Choose **Show recent habit counts** in a habit's details. The app displays up to seven daily or weekly periods ending at the selected period, using that habit version's time zone. The Instance sums unreversed records, with zero for periods that have no recorded count. Older versions use their own schedule and records.

The chart is optional and uses only counts from the current habit owner's exact membership. A household role does not grant access to someone else's chart. Each chart row shows the recorded count and the exact revision’s minimum or maximum target in accessible text. Closing the habit view also hides its chart. Dates and numbers follow the account’s formatting locale. Charts read currently retained events directly. An event reversed or removed from the database no longer contributes, and there are no stored trend aggregates to purge. Shared or cross-household reports require a separate visibility and retention design.

## One-off check-ins with an optional reviewer

A member writes their own one-off check-in and chooses sole access or one active reviewer. The app displays the audience before saving. The selected reviewer can mark that exact submission reviewed. The author can withdraw it, clearing its title and response from the live record. Membership departure removes access for the affected member and stops disclosure to any reviewer of an ended author. Pause prevents new shared submissions and reviews, while private entries and withdrawal stay available. No recurring assignment, external notification or consequence is generated.
