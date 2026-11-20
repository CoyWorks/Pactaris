# Household authority

Pactaris supports long-term D/s dynamics. A household can be private (one Dom and one sub) or hold several Doms and several subs. Consent is given **once per Dom link**: when a sub accepts a Dom. Within that link the Dom acts directly: assigning tasks, giving or taking points and giving punishments needs no per-item acceptance. Pactaris records what people do; it does not take over their responsibility for consent, and it does not require everything to be confirmed by both sides.

What never changes: every member can pause themselves and stop the household at any time, a sub can end a link at any time, activities a person blocked in their limits stay blocked, and nothing automatic runs during a pause or after a link ends.

## Model

| Concept | Rule |
| --- | --- |
| Dom link | A Dom invites a member; that member accepts once. Either can end it at any time; ending needs no reason and also works during a pause. No expiry. |
| Own authority | A sub's own Doms have full authority over that sub: tasks, points and punishments, and managing the link (settings, delegation, rank). |
| Delegation | A Dom can delegate authority over one of their subs to another member, per area (`tasks`, `points and punishments`), optionally until an end time. The sub does not consent again. The Dom, the delegate or the sub can revoke it. |
| Sub ranking | Manual, 1 (highest) to 99, set by a Dom of that sub or by the household owner. Only members who are someone's sub can have a rank. A higher-ranked sub has authority over lower-ranked subs: by default tasks only. Each Dom of the lower sub chooses `off`, `tasks` or `tasks, points and punishments`; the most restrictive setting of the sub's Doms applies. |
| Visibility | The owner decides whether subs and Doms in the household see each other's links and ranks. A Dom can keep one of their subs hidden. Without visibility a member sees only their own links and links delegated to them. |

## How it plugs into existing modules

For every pair with authority (own link, delegation or rank) the Instance keeps a **backing set**: a two-person relationship, a non-expiring agreement covering tasks, protocols, rewards, consequences and reminders, and an active *direct* assignment policy. `authority_sync` creates and removes these sets whenever links, delegations, ranks, settings or memberships change. `activity_guard` treats a backing agreement by the live authority: both members active and not paused, no pause on the relationship, no blocked activity, and authority for the area (tasks for tasks/protocols/reminders, points and punishments for rewards/consequences). Per-version acceptance epochs and expiry do not apply to backing agreements. Ordinary agreements keep their existing rules.

As a result, shared tasks, task rewards, point balances, reward redemption, task inbox notices, exchanges and the People overview work for linked pairs without further steps. Existing adopted standing authority was converted to Dom links by migration `0037_household_authority`; two-person agreements behind them became backing agreements.

## Direct outcomes

- **Points:** someone with points-and-punishments authority adds or removes points with an optional reason. The balance never shows below zero.
- **Punishment:** creates an ordinary shared task assigned directly to the sub, with the usual inbox notice. It can be linked to a breach record.
- **Breach record** (see [DYNAMIC_EXCHANGES.md](DYNAMIC_EXCHANGES.md)): recorded at once and shown to the sub; there is nothing to confirm.

## Security and privacy

- Tables `authority_links`, `authority_delegations`, `authority_pairs`, `point_adjustments`, `authority_punishments` and `authority_receipts` use FORCE RLS. The runtime role reaches them only through `authority_command` and `authority_export_page`.
- Commands use signed per-request delegation, operation IDs with request fingerprints, receipts, an audit event per change and the restore fence. The gateway stores no authority data.
- Ended links and revoked delegations are journaled (`authority.ended`, `delegation.revoked`) and replayed after a restore, so authority cannot return from a backup.
- Departure ends the member's links and delegations and clears their rank. Account erasure blanks link names they wrote and reasons they gave for point changes.
- Personal export section `authority` contains the person's links, delegations and point adjustments.

## In the app

- **Dynamic → Doms and subs:** invite a sub, accept or decline an invitation, end a link, rank, delegation and per-sub settings, and the owner's visibility switch.
- **Today → Needs your attention:** invitations waiting for your answer.
- **Dynamic → People:** per person you hold authority over: rank, points, what is waiting, tasks to review and overdue, and buttons for a task, a breach, points and a punishment.
