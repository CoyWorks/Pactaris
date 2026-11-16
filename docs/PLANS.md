# Free and paid plans

Status: packaging proposal, 16 November 2026. No price or commercial limit has been selected. Numbers below are illustrative starting points for cost and usability validation ([#54](https://github.com/CoyWorks/Pactaris/issues/54)).

## Billing scope

Recommended initial model: a plan belongs to a household and a global account is its billing sponsor. A person can participate in multiple households with different sponsors/plans without purchasing a subscription merely to join. Paying does not grant technical administrator rights or authority over another person's consent.

An account may create/sponsor one free household initially. Additional sponsored households can each have a paid subscription; shared bundles are a later option. Moving a household to another instance does not change its plan or charge participants again. Transfers of sponsor/ownership require explicit verified actions and preserve private-data rights.

## Illustrative feature matrix

Limits apply per household unless stated otherwise. “Included” does not mean already implemented.

| Feature | Free proposal | Plus proposal | Pro proposal |
| --- | --- | --- | --- |
| Active members | 4 | 10 | 25 |
| Multiple contextual roles, switches, overlapping BDSM/romantic relationship forms | Included | Included | Included |
| Basic negotiation, hard/soft limits, safewords, consent and pause/stop | Included | Included | Included |
| Basic privacy controls, MFA and device/session controls | Included | Included | Included |
| Personal export, deletion and leave | Included | Included | Included |
| Core activity/audit access to own/permitted records | Included | Included | Included |
| Active tasks | 25 | 250 | 1,000 |
| Active recurring task/check-in schedules | 5 | 50 | 250 |
| Active rules/protocols | 10 | 100 | 500 |
| Basic sessions and aftercare check-ins | Included | Included | Included |
| Session planning extras | Manual/basic planner | Reusable plans and richer templates | Advanced reusable workflows |
| File storage | 100 MB | 2 GB | 10 GB |
| In-app inbox and basic Web Push/reminders | Included | Included | Included |
| Reminder extras | Simple schedule | Digests and richer schedules | Advanced notification workflows |
| Enabled automation rules | 2 simple rules | 20 with richer conditions | 100 with multi-step actions |
| Templates | Manual authoring and starter set | Expanded curated library | Advanced reusable template sets |
| Planner / ICS feeds when implemented | Basic planner and 1 revocable feed | More feeds/views | Advanced planning/export convenience |
| Reflection/insights | Own basic history | Optional permitted trends | Advanced permitted summaries |
| Themes/layouts | Accessible standard themes | Extra themes and layouts | Advanced layout convenience |
| API/integrations | Basic manual export | Selected integrations | Scoped API/webhooks and larger budgets |
| Infrastructure backup and recovery baseline | Included | Included | Included |

A free household must support both a pair and Dom/Dom/sub/sub group. Do not limit relationship types, role labels per person, ability to switch, romantic overlap or the scope of personal privacy. Fair-use/abuse limits still apply consistently without encoding one relationship form as premium.

Automation rule count is not a sufficient cost bound: define monthly execution budgets, concurrency and rate limits during validation. Attachment per-file limits, notification budgets and absolute abuse ceilings also need measured values. Do not advertise “unlimited.” Basic export remains complete for permitted data; paid export features can add formatting or scheduling convenience.

Do not charge for longer access to essential consent records or a member's own core history. Archiving a protocol or completing a task can release active-capacity usage without deleting authorized history.

## Entitlement architecture

Build this in M0 ([#53](https://github.com/CoyWorks/Pactaris/issues/53)), even if only the free plan is enabled initially.

- Use stable versioned capability keys, such as `members.active.max`, `tasks.active.max`, `schedules.active.max`, `storage.bytes.max`, `automation.rules.max` and `automation.executions.period.max`.
- Keep technical permission, current consent/safety and commercial entitlement as separate checks. A paid capability never supplies consent or permission.
- Reserve/release finite quotas atomically. Count pending invites as reserved capacity with an expiry policy so simultaneous acceptances cannot overfill a household.
- Apply the same checks to UI, API, worker, imports and recurring generation. Use idempotency keys and usage reconciliation.
- The billing/manager side owns commercial plan state. Instances own operational usage and cache authenticated versioned entitlement snapshots.
- Events can arrive late or out of order. Verify versions, reconcile and define bounded grace behavior; do not zero all entitlements on provider/manager outage.
- Keep safety/leave/export/delete accessible during overage, expired plan or manager outage under valid local authorization.

See [#61](https://github.com/CoyWorks/Pactaris/issues/61) for subscription-to-instance synchronization. Prices, taxes, processors and acceptable-use fit remain decisions in [#42](https://github.com/CoyWorks/Pactaris/issues/42). No provider is selected or assumed compatible with adult BDSM/kink content.

## Downgrade and nonpayment

1. Show current usage and future limits before a change.
2. Keep existing members, accepted agreements, roles and authorized records accessible. Do not auto-remove people or erase data.
3. Restrict only creation of new billable capacity. Explain how completing/archiving work, reducing future schedules or removing owned files can resolve overage.
4. Pause excess premium automation without penalizing anyone; communicate which rules stopped and never silently replay a backlog after upgrade.
5. Allow retrieval, complete permitted personal export, deletion, stop and departure regardless of storage/task overage.
6. Define grace, cancellation, refunds/chargebacks, sponsor transfer and retention before taking payments.

## Delivery

Foundation: [#53](https://github.com/CoyWorks/Pactaris/issues/53). Validate the matrix: [#54](https://github.com/CoyWorks/Pactaris/issues/54). Select/integrate billing: [#42](https://github.com/CoyWorks/Pactaris/issues/42). Synchronize plans to instances: [#61](https://github.com/CoyWorks/Pactaris/issues/61). Run free four-person and downgrade tests before selling upgrades.
