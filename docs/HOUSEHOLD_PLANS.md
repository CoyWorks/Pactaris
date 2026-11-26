# Household plans (#53, #61)

Owner decisions, 26 November 2026.

## Model

- **Per dynamic.** A plan belongs to a dynamic, not to a person. Any member can add months.
- **Levels:** Free, Level 1 and Level 2. One month of Level 2 equals two months of Level 1.
  - Adding months of the current level extends it.
  - Adding months of the other level first converts the time left at that rate, then adds the purchase.
  - When the time runs out, the dynamic is on Free. Free never expires.
- **Two ways to pay:**
  - *Prepaid*: months paid once.
  - *Subscription*: each paid cycle adds one month.
- **At most one live subscription per dynamic** (active or paused). Others can still add prepaid months.
- **Stopping a subscription:** only the holder can stop it. An operator can pause, resume or stop it when the holder cannot.
- **What every member sees** under Dynamic → Settings → Plan:
  - the level and until when;
  - prepaid or subscription, with the holder's name;
  - the current limits;
  - **Time added**: who added how many months of which level, and when.
  
  Prices are never stored or shown. Operator grants show as "Pactaris added…".
- **No payment provider yet.** Extend answers `payments_unavailable`. PayPal is the likely first provider; check its acceptable use policy for adult-oriented services first (see docs/PLANS.md). The provider integration adds `prepaid` and `subscription` credits with its own payment reference, so a payment counts once.

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
- **The other keys** are sent to the Instance already. Enforcing them is the next step: new items above a limit are refused, while existing items keep running and nothing is deleted.
- **Always free:** safety, consent, privacy, export, leaving and deletion.

## Delivery to the Instance

- **Gateway** (migration `0030_household_plans`):
  - `household_plans`: level, `paid_until`, extra places, `version` and `synced_version`.
  - `plan_credits`: the list of added time.
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
  - `POST /api/households/:id/plan/extend {tier,months}`: payments not yet available
  - `POST /api/households/:id/plan/cancel`: holder only
- **Operators:**
  - `GET /api/operator/households/:id/plan`
  - `POST /api/operator/households/:id/plan` with one of:
    - `{action:'grant',tier,months}`
    - `{action:'members',extra}`
    - `{action:'pause'|'resume'|'stop'}`
  - Each change is recorded in the operator audit log.
- **Code:** `apps/gateway/plans.ts`, `packages/auth/plans.ts`, `apps/instance/web/plans.tsx`.
