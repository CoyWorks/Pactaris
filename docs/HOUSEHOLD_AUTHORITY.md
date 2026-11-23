# Household authority

Pactaris supports long-term D/s dynamics. A household can be private (one Dom and one sub) or hold several Doms and several subs. Consent is given **once per Dom link**: when a sub accepts a Dom. Within that link the Dom acts directly: assigning tasks, giving or taking points and giving punishments needs no per-item acceptance. Pactaris records what people do; it does not take over their responsibility for consent, and it does not require everything to be confirmed by both sides.

What never changes: every member can pause themselves and stop the household at any time, a sub can end a link at any time, activities a person blocked in their limits stay blocked, and nothing automatic runs during a pause or after a link ends.

## Model

| Concept | Rule |
| --- | --- |
| Dom link | A Dom invites a member; that member accepts once. Either can end it at any time; ending needs no reason and also works during a pause. No expiry. |
| Primary Dom | Every sub has exactly one primary Dom (owner decision, 21 November 2026; migration `0044_primary_dom_rights`). Only the primary Dom has all rights over the sub by default: creating tasks and habits, approving tasks, points and punishments, and managing (rank, delegation, transfer). The first Dom a sub links with becomes primary. Other Doms of the same sub keep their link but have no rights except the ones the primary Dom gives them. |
| Transfer | The primary Dom proposes another member (ranked above the sub) as primary Dom. It takes effect when **the new Dom and the sub** both accept; the old Dom does not need to do anything more. Rights the old primary Dom handed out are revoked. If the new Dom had no link with the sub, the sub's acceptance is their consent to one. Losing the primary role is journaled (`primary.released`) so it cannot come back from a backup. Without a primary Dom (the link ended, or an older household where a sub had several Doms) any of the sub's own Doms can propose a primary Dom, themselves included; the sub accepts. |
| Rights | The primary Dom gives separate rights to a member, optionally until an end time: `tasks` (create tasks and habits), `approve` (approve submitted tasks) and `outcomes` (points and punishments). Only members ranked above the sub can receive rights: anyone without a sub rank, or a sub with a higher rank. The sub does not consent again. The primary Dom, the holder or the sub can revoke a right. |
| Sub ranking | Manual, 1 (highest) to 99, set by the primary Dom or the household owner. Only members who are someone's sub can have a rank. Rank sets the order and who counts as ranked above a sub; it gives no rights by itself (owner decision, 21 November 2026; the earlier rank authority is gone). |
| Visibility | The owner decides whether subs and Doms in the household see each other's links and ranks. A Dom can keep one of their subs hidden. Without visibility a member sees only their own links and links delegated to them. |

## How it plugs into existing modules

For every pair with authority (primary Dom or a delegated right to create tasks or give outcomes) the Instance keeps a **backing set**: a two-person relationship, a non-expiring agreement covering tasks, protocols, rewards, consequences and reminders, and an active *direct* assignment policy. `authority_sync` creates and removes these sets whenever links, delegations, ranks, settings or memberships change. `activity_guard` treats a backing agreement by the live authority: both members active and not paused, no pause on the relationship, no blocked activity, and authority for the area (tasks for tasks/protocols/reminders, points and punishments for rewards/consequences). Per-version acceptance epochs and expiry do not apply to backing agreements. Ordinary agreements keep their existing rules. Backing relationships carry `relationships.system` (migration `0041_progress_board`) and are left out of the Relationships list and its commands; they change only through authority. Relationships that existed before a link and were reused for it stay visible.

As a result, shared tasks, task rewards, point balances, reward redemption, task inbox notices, exchanges and the People overview work for linked pairs without further steps. Existing adopted standing authority was converted to Dom links by migration `0037_household_authority`; two-person agreements behind them became backing agreements.

## Approval by several people

Owner decision, 21 November 2026: a task is approved by several people ranked above the sub, with a simple approve button (no signatures).

- When the sub submits, an approval round opens. Its approvers are the task's creator plus every active member who holds the `approve` right over the sub at that moment (the primary Dom has it by default; others through a delegation). Each approver except the creator receives an `approval` notice.
- The task is done once every approver of the round has approved. One approval of several is recorded on the task history (`partnerApproval`) and the task stays submitted.
- Any approver may ask for changes. That ends the round: all approvals lapse, the round's photo is deleted, and the next submission opens a new round with the approvers who hold the right then.
- The right is checked again at each decision; a revoked delegation, a pause or a stop wins. Tasks submitted before approval rounds existed keep the creator-only path.
- `approvalList` shows the tasks waiting for the caller; `approvalRead` shows one of them (title, description, the submission note, the round and the photo state) to its approvers only, including a reviewer who is neither creator nor assignee.
- Photo proof follows the round: see [TASK_PROOF.md](TASK_PROOF.md).

## Direct outcomes

- **Points:** someone with points-and-punishments authority adds or removes points with an optional reason. The balance never shows below zero.
- **Punishment:** creates an ordinary shared task assigned directly to the sub, with the usual inbox notice. It can be linked to a breach record.
- **Breach record** (see [DYNAMIC_EXCHANGES.md](DYNAMIC_EXCHANGES.md)): recorded at once and shown to the sub; there is nothing to confirm.

## Habits set by a Dom

Someone with task authority over a sub can set a daily or weekly habit for them: at least or at most a number of times, in a chosen time zone. The sub (or the Dom) records progress with **+1** on Today; the Dom follows it under People → Habits. Optional automatic outcomes, for someone with points-and-punishments authority: points when reached, points taken when missed, and a punishment task when missed.

The worker (`run_authority_habits`) checks each ended period once. It applies outcomes only with live points-and-punishments authority, an active household, no pause on either person and no blocked activity (`reward` for points given, `consequence` otherwise). Otherwise the period is recorded as *skipped*; skipped and paused periods are never made up later, and resuming a paused habit starts at the current period. Periods missed while the worker was down are evaluated for at most a week back. Entries can be reversed until their period has been checked.

## Streaks and milestones

Migration `0043_habit_streaks`. A **streak** is the number of consecutive periods a habit was reached, counting back from the latest closed period; a paused (`skipped`) period is neutral — it neither breaks nor extends the streak — and a `missed` period breaks it. `habit_streaks` returns the current and longest streak and is included in `habitList`.

A Dom can set a **milestone** on a habit: `milestone_every` (2–365) and `milestone_points` (1–10 000), stored on `authority_habits` and set together or not at all. When the worker records a reached period and points are on, it counts the streak including that period; if it is a multiple of `milestone_every`, the sub gets `milestone_points` bonus points (a `point_adjustment`, on top of any per-period reward), recorded in the result's `outcome` as `milestonePoints` and `streak`. Milestones never fire on a missed or skipped period or during a pause.


On a Dom link the Dom can switch off **spending points on rewards** and **sending proposals**. When a sub has several Doms the strictest setting applies. Permission requests, journal entries, pausing, stopping and ending a link can never be switched off.

## Progress and the household board

`progressList` (read only, `authority_progress_command`) returns, per visible sub, the last 14 days in the household time zone: shared tasks approved per day, points earned per day (approved task points that were not reversed, plus point changes, which include habit outcomes; spending on rewards is not subtracted), habit periods reached and missed (a weekly period counts on its last day), plus open shared tasks, current balance, rank and the names of their Doms. At most 50 people.

Who is visible: yourself when you are a sub in an active link, every sub you hold task or outcome authority over, and, when the owner made subs visible and you are part of an active link, every sub without a private link. The same rule as the ranking list; personal-private data is not included.

## Reward shop and punishment list

Migration `0042_reward_shop`, command `shop_command` (`shopList`, `shopSave`, `shopArchive`, `shopBuy`).

- A Dom's rewards and punishments are their own catalog items (kinds `reward` and `consequence`). `shopSave` creates or revises one; for a reward it also sets whether it is **in the shop**, whether a purchase is **granted at once** and an optional **limit per week** (1–100, counted from Monday 00:00 in the household time zone). Putting a reward in the shop publishes its title, description and price to the subs below; everything else in the catalog stays private.
- A sub sees the listed rewards of every Dom with points authority over them (`authority_area … 'outcomes'`). `shopBuy` names the item version the sub saw, so a price change is a conflict. It runs on the backing agreement through `activity_guard` with activity `reward`: pauses, stops, a blocked reward category and a Dom who switched off spending all refuse it. Then the weekly limit and the available points are checked.
- A purchase is a reward redemption marked `source: shop`. Granted at once, it is `fulfilled` with its debit. Otherwise it is `requested`, which holds the points for 14 days. The Dom grants or declines it with the existing `redemptionFulfill` / `redemptionDecline`, and the sub can cancel it. An expired request frees the points. The Dom gets a `purchase` notice.
- Punishments are only a list for the Dom. Picking one fills the title and text when giving a punishment, recording a breach or setting a habit's punishment; the punishment itself still goes through `punishmentGive` or the habit worker.
- `shop_listings` uses FORCE RLS and is reached only through `shop_command`. Purchases are reward redemptions and appear in the existing catalog export. Listing settings are not in the personal export.

## Security and privacy

- Tables `authority_links`, `authority_delegations`, `authority_pairs`, `point_adjustments`, `authority_punishments` and `authority_receipts` use FORCE RLS. The runtime role reaches them only through `authority_command` and `authority_export_page`.
- Commands use signed per-request delegation, operation IDs with request fingerprints, receipts, an audit event per change and the restore fence. The gateway stores no authority data.
- Ended links and revoked delegations are journaled (`authority.ended`, `delegation.revoked`) and replayed after a restore, so authority cannot return from a backup.
- Departure ends the member's links and delegations and clears their rank. Account erasure blanks link names they wrote and reasons they gave for point changes.
- Personal export section `authority` contains the person's links, delegations, point adjustments and assigned habits with their entries and results. Departure archives the person's habits; erasure blanks habit text they wrote.

## In the app

- **Dynamic → Doms and subs:** invite a sub, accept or decline an invitation, end a link, rank, rights per member, transferring the primary role and per-sub settings (hidden, spending points, proposals), the ranking list and the owner's visibility switch.
- **Today → Needs your attention:** invitations waiting for your answer.
- **Dynamic → People:** per person you hold authority over: rank, points, what is waiting, tasks to review and overdue, and buttons for a task, a breach, habits, points and a punishment.
- **Today → Habits from your Dom:** progress, current streak and +1 for the sub.
- **Tasks → Shared tasks → Give a task:** choose the person and write the task; it goes straight to them through the backing direct policy. People → **Assign a task** opens it with the person chosen, the add menu opens it empty. Offers through an agreement and older standing assignments are under **Offers and agreements**.
- **Habit form:** a Dom can turn on a streak bonus (every N reached in a row → bonus points). The people list and Today show the current streak, and the people list also the best streak.
- **Dynamic → People → Progress:** last 7 days (tasks done with the change against the week before, points, open tasks, habits reached and missed), daily bar charts for tasks and points over 14 days, and a table view.
- **Dynamic → Rewards and punishments:** for a sub, the shop with balance, prices, limits and recent purchases (a waiting request can be cancelled). For a Dom, purchases waiting for them (grant or decline) and their own rewards and punishments.
- **Picking a punishment:** "From your list" appears in the punishment form, the breach form and the habit form.
- **Today → Getting started** (owners and administrators): invite people, link as Dom and sub, give a first task. Hidden on this device once dismissed or after the first task.
- **Dynamic → Household board:** everyone you may see, by rank, with their last 7 days and balance; a row opens the same progress view. Shown when you are part of an active Dom link.

### Assigned habit weekdays

New daily assigned habits can select one or more ISO weekdays. Weekly count-based habits retain their existing weekly period. A daily period outside the selected weekdays is recorded as skipped and cannot issue an outcome. The weekday selection is fixed when the habit is created to avoid reinterpreting past periods; older clients and existing habits default to every day.

### Scheduled breaks and safety fences

For assigned habits, the sub and the holder with task authority can schedule inclusive date breaks in the habit's time zone. Any overlapping daily or weekly period is skipped, with no points, punishment, reward, or streak change. The sub may cancel either participant's break; the holder may only cancel their own. Cancelling an active break keeps the overlapping period skipped. Pauses, household stops, relationship holds and authority changes fence pending periods through the current period even after resumption. Breaks are included in the existing habit export and removed when either participant is erased; departure archives the habit. Migration 0053 extends the link safety fence for primary-transfer and rank changes. Migration 0050 redeclares `run_authority_habits` and `authority_habit_command` from 0049 and adds safety triggers.

Assigned habits also have an optional category and a bounded history of the 20 most recent entries and seven evaluated periods. Authorized participants can reverse eligible entries in the app; reversed entries remain visible and do not count towards the total. Closed-period entries cannot be reversed after evaluation. The creator chooses a time zone when creating an assigned habit. Migration 0052 adds the category, erasure handling, and extends `authority_habit_command` from 0050 with history and category projection.

Migration 0054 redeclares `authority_habit_command` from 0052 with an unambiguous progress-entry query alias.

Migration 0056 redeclares `run_authority_habits` from 0050 to suppress even older pending outcomes while a scheduled break is currently active.
