# Direct assignment, planning and recurring tasks

Confirmed owner direction, 17 November 2026. This corrects the mandatory per-task acceptance direction in the first #17 participant workflow. It is a product requirement and next implementation plan, not a claim that scheduling, automatic assignment or reward execution is already available in 0.12.

## Normal D/s task experience

A Dom with task-assignment authority in the relevant agreed dynamic creates a task for a sub, including its schedule, recurrence, optional reward/points and review requirements. Assignment immediately places it in that sub's personal task list, planner and appropriate to-do view. The sub does not have to accept each task for it to appear or become actionable under the standing task policy.

Acceptance is an optional workflow setting, not a universal gate. Support direct assignment under standing scope and a separate explicit-acceptance mode where that dynamic requires it. Authorization comes from the relationship's agreed task authority and participants; a household administrator or global Dom label alone does not grant it. Someone may assign tasks as Dom in one relationship while receiving tasks as sub in another.

A directly assigned task is accurately shown as assigned/planned/to do, not falsely recorded as individually accepted by the assignee. Existing per-task acceptance is not a prerequisite for displaying assigned content, counting it in the personal overview or presenting upcoming planned work. Private tasks remain separate. A one-person owner can prepare task definitions/schedules/reward proposals before inviting anybody; an unassigned draft does not invent a partner or an active grant.

## Task definition and occurrence

The creator-facing editor should configure these together rather than require unrelated advanced setup screens:

- Title, description, priority, assignee and the relevant relationship/dynamic scope.
- One-off start/availability and due time, or recurrence: daily, weekly/selected weekdays, start/end dates and IANA timezone. Show upcoming work and distinguish planned, actionable, submitted, completed, cancelled and overdue states.
- Optional reward or non-monetary points linked to the task's agreed completion condition, with optional creator review. Copy/version the selected proposed reward terms deliberately; linking one item never exposes the rest of a private catalog.
- Optional per-task acceptance and review policy within the standing task scope.

Separate a versioned task/series definition from uniquely identified dated occurrences. Definition edits have an explicit future-occurrence policy and do not rewrite already submitted/completed work. A series appears in the assignee's overview immediately; a bounded upcoming window and an explicit later-series view avoid an infinite checklist. Individual occurrences enter planned/to-do views according to availability and due dates, without an acceptance gate in direct mode.

## Background processing and effects

The Instance worker creates occurrences and reminders while the browser is closed, using persisted rules, unique series/occurrence keys, transactional jobs/outbox, retries/backoff and defined missed-run/catch-up policy. Account API polling at 60 seconds or later push delivery only refreshes the view; it is not the scheduler. Handle DST/calendar boundaries and pause/resume without silently creating a punitive backlog.

Check the current standing scope, membership, permissions and pauses when assignment or a protected effect executes. Pausing, withdrawing or leaving remains available without the Dom's approval and does not automatically create a consequence. An invalid/expired/revoked scope blocks execution/effects while permitted history and corrective actions remain available. Prevent stale or duplicate jobs from acting on ended memberships or migrated Instances.

Optional reward/points execution belongs to a reversible ledger: key effects by occurrence, rule version and completion event, apply the agreed review/completion condition, and never double-grant on retry or reopen/recomplete. Any correction has an explicit linked reversal. Automatic rewards within standing agreed scope do not require a separate acceptance prompt for every task. Automatic consequences are not introduced as the default for missed work or withdrawal.

## Implementation order and compatibility

1. #17: relationship-scoped standing assignment policy and optional acceptance mode; direct assignment appears immediately in the assignee's lists/to-do flow. Preserve existing private task behavior and exact participant visibility.
2. #18: versioned one-off/recurring definitions, dated occurrences and autonomous worker processing. Add the planned/upcoming personal view and recurrence editor without making page visits responsible for generation.
3. #20/#64: bind deliberately shared reward terms and idempotent completion/review effects to the task/occurrence. Retain catalog draft preparation without executing a grant.
4. #22: notification inbox/preferences and the bounded 60-second freshness API; optional push #23 follows the same visibility and delivery rules.

Existing 0.12 offers retain their recorded pending/accepted/declined decisions. Moving a dynamic to standing direct assignment is an explicit, versioned policy adoption; do not manufacture past acceptance or silently broaden old agreements. Shared active-task capacity and safe downgrade behavior remain enforced; define series/occurrence counting before generating scheduled work. Preserve keyed English messages, canonical hidden-Instance routing, current privacy boundaries and additive migration/update discipline.

## Acceptance examples

- Dom assigns a one-off task under standing task scope: it immediately appears in the sub's list/to-do view, without a per-task acceptance action.
- Dom creates a weekly task with a reward: its series/upcoming occurrence is visible immediately and later occurrences are generated once while no browser is open.
- A separate dynamic configured for explicit acceptance still supports its chosen offer/accept/decline flow, with the assigned offer visible before that decision.
- A contextual switch can assign to one partner and receive from another; unrelated household members/admins see neither private task stream.
- A completed occurrence triggers only its agreed reward once; retry, review races and reopening do not duplicate it. Pause/departure/revocation prevent stale jobs/effects and never cause default punishment.

## Standing authority implementation checkpoint

Current source adds explicitly adopted, versioned directional task authority, direct one-off assignment and optional per-task acceptance while preserving existing offers. See [STANDING_TASK_AUTHORITY.md](STANDING_TASK_AUTHORITY.md) for the API, lifecycle, migration, verification limits and remaining scope. The earlier 0.12 state table/checkpoint is historical; scheduled series and rewards remain follow-up work.
