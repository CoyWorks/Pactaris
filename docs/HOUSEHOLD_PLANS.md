# Household plans (#53, #61)

Owner decisions, 26 November 2026 (level change and prices updated the same day).

## Model

- **Per dynamic.** A plan belongs to a dynamic, not to a person.
- **Levels:** Free, Level 1 and Level 2. When the time runs out, the dynamic is on Free. Free never expires.
- **Adding months:** any member can add months at the current level. On Free there is nothing to extend; the owner chooses a level first.
- **Changing level: household owner only.**
  - The owner first asks for a quote. It shows the new level's monthly price and the new end date. Nothing changes yet.
  - The owner then confirms. The confirmation carries the quote's plan version; if the plan changed in between, it is refused and the owner sees a fresh quote.
  - The remaining time converts. Internal rule, **not shown in the app**: one month of Level 2 equals two months of Level 1.
  - Moving up from Free needs a payment and waits for the payment provider.
  - A live subscription moves to the new level with the plan (telling the provider is part of the payment integration).
  - Each change is listed under *Time added* as "{name} changed the level to …" (`plan_level_changes`).
- **Two ways to pay:**
  - *Prepaid*: months paid once.
  - *Subscription*: each paid cycle adds one month.
- **At most one live subscription per dynamic** (active or paused). Others can still add prepaid months.
- **Stopping a subscription:** only the holder can stop it. An operator can pause, resume or stop it when the holder cannot.
- **What every member sees** under Dynamic → Settings → Plan:
  - the level and until when;
  - the **monthly price of the current level only** (never a price list, never the conversion rule);
  - prepaid or subscription, with the holder's name;
  - the current limits;
  - **Time added**: who added how many months of which level, and when.
  
  Amounts paid are never stored. Operator grants show as "Pactaris added…".
- **Prices** come from the gateway configuration (`/opt/pactaris/gateway/config.json`, top level), in minor units (cents). Without `planPrices` no price is shown. Live since 26 November 2026: Level 1 €1.50 and Level 2 €3.00 per month.

  ```json
  "planPrices": { "currency": "EUR", "monthly": { "level1": 150, "level2": 300 } }
  ```
  After a change, restart the gateway service (the worker does not use prices). Keep Level 2 at twice Level 1: the time conversion between levels assumes that ratio.
- **No payment provider yet.** Extend answers `payments_unavailable`. PayPal is the likely first provider; check its acceptable use policy for adult-oriented services first (see docs/PLANS.md). The provider integration adds `prepaid` and `subscription` credits with its own payment reference, so a payment counts once.

## Ending, grace and downgrade (owner decisions, 27 November 2026)

- **Warning.** When a plan does not renew by itself, every member sees a notice in the last 7 days before it ends (`planWarningDays`): on Today and in the Plan panel.
  - A plan does not renew when it is prepaid or its subscription is paused or stopped.
  - An active subscription renews, so it gets no notice.
- **Quiet grace period.** After paid time ends, the paid limits still apply for 7 more days (`planGraceDays`, `enforcedTier`).
  - **Not advertised.** Members see the plan as Free as soon as the paid time is over. The site and the app never mention the grace period.
  - Only the operator console shows it, for support.
  - The worker expires the plan, and sends the Free limits to the Instance, when the grace period ends.
  - Adding months during the grace period starts from the moment of payment.
- **Downgrade.** Nothing is deleted, nobody is removed, and these always work:
  - every basic function of a relationship: pause and resume, stop, consent, limits and safewords, ending a link, leaving;
  - viewing, export, check-ins, submitting and reviewing, and shop redemptions.
- **Only the excess is frozen** (enforcement on the Instance, next step).
  - New items above a limit are refused.
  - Items above a limit are paused. The Dom or owner chooses which stay active.
  - Paused items cannot be edited until there is room again or after an upgrade. Completing, archiving, deleting and pausing always work.
  - A paused habit or routine records no missed periods and gives no punishment. After resuming it does not catch up on the paused time.

## Limits (placeholders)

| Capability key | Free | Level 1 | Level 2 |
|---|---|---|---|
| `members.active.max` | 4 | 8 | 16 |
| `oneoff.open.max` | 10 | 40 | 150 |
| `series.active.max` | 3 | 15 | 50 |
| `habits.assigned.max` | 3 | 15 | 50 |
| `routines.active.max` | 3 | 15 | 50 |
| `plan.horizon.days` | 14 | 92 | 366 |
| `catalog.rewards.max` / `catalog.punishments.max` / `shop.items.max` | 5 | 30 | 100 |
| `history.days` (0 = no limit) | 30 | 366 | 0 |

The values live in `packages/auth/plans.ts`.

- **Members:** `members.active.max` is the level's number plus the operator's *extra member places*. It is already enforced: invitations cannot overfill a dynamic.
- **"Need more members?"** When an invitation fails on the member limit, the link opens a report with the category *More members needed* and the dynamic's ID. Operators see that ID with every report, and then set extra places in the console.
- **Counting (owner decision, 28 November 2026; Instance migration `0071_plan_limits`).** Some limits count **per person**:

  | Key | Counts | Whose |
  |---|---|---|
  | `oneoff.open.max` | open own tasks, plus Dom/sub tasks that are not done, declined or cancelled; generated occurrences of a series do not count | the assignee, or the creator for own and unassigned tasks |
  | `series.active.max` | active or blocked series, and personal series | the assignee; for a personal series, its owner |
  | `habits.assigned.max` | active or paused Dom-set habits | the sub |
  | `routines.active.max` | draft, active or paused routines | the creator |

  The others count **per dynamic**: rewards (`catalog.rewards.max`, every kind except consequences), punishments (`catalog.punishments.max`, consequences) and shop listings (`shop.items.max`).
- **Enforcement.**
  - Database triggers refuse a new item, or one that comes back into use (reopened, restored from the archive), when the limit is reached. They work under the dynamic's lock, so concurrent requests cannot overbook.
  - Completing, archiving, cancelling, declining, pausing and editing are never refused.
  - Pausing does not free a place, so resuming is never refused.
  - Each module answers with its own capacity error: `workspace_capacity`, `partner_capacity`, `authority_capacity`, `routines_capacity` or `catalog_capacity`. The message points to Settings → Plan.
  - Without a delivered plan, the Instance uses the Free values. A unit test keeps them equal to `packages/auth/plans.ts`.
  - **Generated occurrences.** A series inserts each occurrence as a task and links it to the series just after. `generate_task_series` and `run_personal_scheduler` are wrapped to mark their own inserts with a transaction-local setting, so a full one-off limit never stops a series.
- **Retired pilot limit.** The shared pilot limit `tasks.active.max` (25 per dynamic) is set to 999999, so it no longer applies.
- **Usage.** The Plan panel shows "used of limit" (`GET /api/households/:id/plan/usage`, Instance `plan_usage`). Per-person rows show the viewer's own use.
- **Plan horizon** (`plan.horizon.days`, Instance migration `0072_plan_horizon`). A date may be set at most this many days ahead. This covers a task's due date (own and Dom/sub tasks), a series' start date (Dom series and personal series) and a one-time routine's date.
  - The check runs only when the date is set or moved. A date set earlier stays after a downgrade, and saving an item with its date unchanged is never refused.
  - Generated occurrences are not checked.
  - Each module answers with its own `*_horizon` error.
- **Not enforced yet:** `history.days` comes in the next step, and so does pausing the excess after a downgrade.
- **Always free:** safety, consent, privacy, export, leaving and deletion.

## Delivery to the Instance

- **Gateway** (migration `0030_household_plans`):
  - `household_plans`: level, `paid_until`, extra places, `version` and `synced_version`.
  - `plan_credits`: the list of added time.
  - `plan_level_changes`: who changed the level, from what to what, and when.
  - `plan_subscriptions`: at most one live subscription per dynamic.
- **When the gateway sends:**
  - Every change bumps `version`.
  - The gateway sends the resulting capabilities straight away.
  - The worker also sends every unsynced version, and bumps the version when a plan expires.
- **How it travels:** a signed system call (`entitlementsApply`) to the dynamic's Instance.
- **On the Instance** (migration `0070_plan_entitlements`): `entitlements_apply` merges the capabilities into `household_entitlements` only if `plan_version` is newer. A late or repeated delivery cannot roll a dynamic back.
- **When the gateway is down**, the Instance keeps its last copy.

## Interfaces

- **Members:**
  - `GET /api/households/:id/plan`
  - `POST /api/households/:id/plan/extend {months}`: at the current level; payments not yet available
  - `POST /api/households/:id/plan/quote {tier}`: owner only; new monthly price, new end date, `needsPayment`, `version`
  - `POST /api/households/:id/plan/level {tier,version}`: owner only; `plan_changed` when the plan moved since the quote
  - `POST /api/households/:id/plan/cancel`: holder only
- **Operators:**
  - `GET /api/operator/households/:id/plan`
  - `POST /api/operator/households/:id/plan` with one of:
    - `{action:'grant',tier,months}`
    - `{action:'members',extra}`
    - `{action:'pause'|'resume'|'stop'}`
  - Each change is recorded in the operator audit log.
- **Code:** `apps/gateway/plans.ts`, `packages/auth/plans.ts`, `apps/instance/web/plans.tsx`.
