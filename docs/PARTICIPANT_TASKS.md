# Participant task workflow — 0.12.0-alpha.1

First bounded partner lifecycle slice of #17. Existing owner-only private/unassigned/self-directed tasks remain separate and do not require a partner. The new Participant tasks section handles explicit shared offers; it does not publish private tasks or expose a household-wide board.

## Owner direction superseding the default workflow

The owner clarified on 17 November 2026 that a Dom must be able to assign planned/recurring tasks directly into the sub's task/to-do list under standing task scope, without mandatory acceptance per task. Acceptance becomes optional. See [TASK_PLANNING.md](TASK_PLANNING.md) and #17/#18/#20/#22. The state table below documents what 0.12 actually implements; it is not the required universal future workflow. No runtime behavior is changed by this clarification alone.

## State and audience

Any current participant in an active, individually accepted task agreement may offer a task to another current participant in that same relationship. Contextual Dom/sub labels and technical administrator roles do not decide who can create or receive an offer. Pairs and multi-person relationships work; only the selected creator and assignee see the task, submission and feedback. Other relationship participants, household owners and administrators receive no extra access.

An offer fixes title, description, priority, optional due instant, assignee and agreement version. The UI explicitly confirms this audience before sending. It never accepts for the recipient. To change scope, cancel and create a new offer. The first reviewer is always the creator; a third-party reviewer is not supported in this slice.

| Current state | Actor and action | Result |
| --- | --- | --- |
| Offered | Assignee accepts or declines | Accepted or declined |
| Accepted / changes requested | Assignee starts | In progress |
| In progress | Assignee submits required text | Submitted |
| Submitted | Creator approves or requests changes with text | Done or changes requested |
| Done | Creator reopens | New offered state, requiring recipient acceptance again |
| Any nonterminal state | Either participant cancels | Cancelled |

Each successful transition increments an optimistic version and adds immutable history. Submission/feedback are limited to 500 characters. Due times use the device timezone on input and household formatting on display; being overdue never creates an automatic consequence. History is paged 10 events at a time; active/closed lists are paged 10 tasks at a time. Former/unnamed membership aliases have a generic fallback; global identity names are not silently published.

## Current consent and concurrency

Offer, accept, start, submit, review and reopen call the existing activity guard in the same household-locked write transaction. It checks the pinned current agreement/version, expiry, all individual acceptances, active relationship/memberships, household/personal/relationship pause and structured task limits. Revised/revoked/expired agreements do not silently update old tasks; cancel/reoffer under a reviewed scope. Reopening never issues a reward or repeats a points outcome.

Each protected write also carries the displayed household epoch and a concurrency fingerprint of the pinned agreement's full decision rows (including decision timestamps). A counterpart's pause and re-consent therefore invalidate an old request even if the task itself did not change. This fingerprint is not a bearer credential: signed delegation, local membership, resource permissions and the authoritative guard are still required. Decline/cancel need no new consent token and remain available while paused or after withdrawal; they still require current party membership and the displayed task version. Reads remain available to active parties when progress is blocked. Closing the household denies access.

Departure/removal cancels nonterminal tasks involving the ended membership and adds a lifecycle event in the same transaction. Rejoining receives a new membership and inherits neither old task visibility nor pending command authority. The remaining active participant can still see permitted cancellation history. Completed histories are not reopened by departure.

## Capacity and infrastructure

Private open tasks and nonterminal participant offers share the existing household tasks.active.max capacity. New capacity triggers enforce a combined count under the common lifecycle lock for both APIs, without rewriting previous migration checksums. Declining/cancelling/completing releases capacity. Downgrade retains content, history and safe exit; it may prevent additional offers or reopening until capacity is available. Current numerical entitlement policy is unchanged.

Browser POST routes stay at `/api/households/:id/participant-tasks/:action`, with session/origin/CSRF, strict inputs, role/state checks and live Instance membership. Options expose only a bounded set of currently eligible task agreements and their current counterpart aliases, never arbitrary household members or private relationship contents. The gateway holds no task bodies. Bounded task/catalog content responses allow at most 64 KiB so valid Unicode text fits; other private command responses retain their 16 KiB bound. These are server-selected transport budgets, not browser input. Instance migration 0013 adds private task/event/receipt/outbox tables, FORCE RLS and a narrow command grant. The concurrency helper is not runtime-callable. Runtime/migration/read-only backup credentials stay separate. Content, history, audit metadata, receipt, durable outbox and JWT replay consumption commit or roll back together; uncertain browser writes retain one exact in-memory retry and never claim offline success.

Lists poll only while visible/online at 60 seconds; detail and creation choices stay pinned until explicitly refreshed/reopened. Outbox events are durable records, not implemented notification delivery. Departures rely on existing membership lifecycle/outbox handling for future notification cleanup. Normal updates activate Instance before gateway and preserve config/secrets, prior checksums and Identity/domain/TLS/proxy settings. The separate production tsconfig and reduced-stack regression from #72 remain required.

## Verification and remaining work

Input/keyed UI tests cover strict scope, identity, current versions, required submission and safe refusal. Native PostgreSQL/HTTPS tests cover pair/four-person audience and role boundaries, full review/reopen history, duplicate intent, stale actor/counterpart safety packets, concurrent review and capacity, limits/expiry, combined private/shared quotas and downgrade, final-write rollback/replay, tenant/Instance/CSRF boundaries, runtime/backup permissions and departure/rejoin fencing. Broader mobile/operator acceptance remains separate.

Optional third-party review, proof uploads #21, dispute resolution, editing/re-negotiating an existing offer, reminders/recurrence #18/#22, audit/export/deletion/retention and reward/ledger effects #20/#64 remain open. No automatic punishment, tracking or device action is introduced. Full off-host restore/revocation replay remains a release gate.

## Standing authority implementation checkpoint

Current source adds explicitly adopted, versioned directional task authority, direct one-off assignment and optional per-task acceptance while preserving existing offers. See [STANDING_TASK_AUTHORITY.md](STANDING_TASK_AUTHORITY.md) for the API, lifecycle, migration, verification limits and remaining scope. The earlier 0.12 state table/checkpoint is historical; scheduled series and rewards remain follow-up work.


## Task inbox preferences

Open the private task inbox and choose **Task inbox preferences**. Active participants can enable or disable new task assignments and offers, submissions, and reviews for their own membership. All three are enabled by default, including for memberships created before this migration. Changes affect new inbox entries and preserve existing entries. A task still appears in the assignee's task lists when its notice is disabled.

The Instance applies the recipient's selection during inbox insertion. Gateway/Instance calls require the usual current session, exact membership and origin/CSRF checks. There are no email or push subscriptions in these settings. Quiet hours and preferences for external channels remain follow-up in #22 and #23.

The participant-tasks tab signals unread notices across the selected household workspace. It reuses the existing visible, online 60-second workspace refresh. The Instance checks only whether an unread record exists for the current membership; the response contains one Boolean. A confirmed mark-as-read immediately refreshes that household’s inbox and workspace indicator. The indicator stays on if the Instance reports other unread notices, including on other pages. A failed workspace refresh removes the indicator until a current response succeeds.
