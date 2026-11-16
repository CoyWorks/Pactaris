# Build order and release gates

The app is BDSM/SM/kink-first. Use issue scopes and dependencies; phases describe roadmap groups, not existing GitHub milestone objects.

## M0 — Domain and hosting foundation

1. Confirm stack, inspected source and license (#1, #2, #50); define the instance/manager and identity/placement contracts (#55, #58) alongside the scaffold (#3).
2. Build PostgreSQL tenancy (#4, #5), independent account sessions (#6), explicit invitations (#8), technical authorization (#9) and consent (#10).
3. Build multiple relationship-scoped BDSM roles and overlapping relationship types now (#35), then individual/relationship/household safety state (#11).
4. Add versioned plan entitlements/usage (#53), transactional audit/outbox (#12) and runtime CI verification (#13).

Acceptance includes pair, Dom/Dom/sub/sub group and one person Dom to A and sub/bottom to B. Admin rights are independent. Entitlement contracts and instance boundaries exist before paid checkout or additional servers are activated.

## M1 — Usable dynamic workflows

PWA/dashboard (#14, #15), protocols (#16), tasks/recurrence (#17, #18), rituals/aftercare/check-ins (#19), optional ledger (#20), private uploads (#21), inbox/push/email (#22–#24), export/deletion (#25, #26), settings (#27) and negotiated play sessions (#52).

First slice: sign in → join explicitly → define accepted relationships/roles → negotiate consent → assign/complete task → stop → export/leave. Validate a free four-person dynamic with multiple roles. Basic negotiation/aftercare is included free. Workers must operate correctly while the browser is closed.

## Launch — Public service and managed instances

Complete MFA (#7), OCI/CloudPanel deployment (#28), backups (#29), monitoring/capacity (#30), security/load checks (#31), adult-service policy/provider review (#32), limited operator administration (#33) and pilot (#34).

Deliver installer (#56), authenticated enrollment/manager inventory (#57), safe upgrades/drain/retirement (#59) and two-instance isolation/outage checks (#62). First-instance public rollout can precede expansion; manager/instance interfaces must already exist. Do not onboard a second public instance before #62 passes.

Verify separate databases/stores/credentials, correct session audiences, local safety during manager outage and restore/deletion reconciliation. Multiple instances alone do not give a household high availability.

## Paid rollout

Seed Free in M0 (#53). Validate [the matrix](PLANS.md) (#54), provider suitability/payment flows (#42) and authenticated versioned entitlement distribution (#61) before charging. No prices or exact commercial quotas are fixed yet.

Test upgrade, over-limit downgrade, sponsor transfer and manager/provider outage. Never auto-evict members, delete records, override agreements or block safety/export/leave/delete.

## Later and wishes

Scoped delegation (#36), templates (#37), planner/ICS (#38), richer automation (#39), search (#40), opt-in insights (#41), billing (#42), API/webhooks (#43), localization (#44), plan validation (#54), household relocation (#60) and subscription synchronization (#61). Standing/member-journey refinements can follow the foundational graph.

Good-to-have/wishes #45–#49 cover convenience and research. Longer-form journaling is optional; basic aftercare is already in #19/#52. See [inventory](FEATURE_INVENTORY.md) and [tracker](https://github.com/CoyWorks/Pactaris/issues/51).

## Existing Site

Version 4 remains unchanged during planning. No new application build or OCI deployment is implied. Implement/cut over through #2/#34 after the foundations are verified.
