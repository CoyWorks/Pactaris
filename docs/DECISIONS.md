# Decisions and open questions

Recorded 16 November 2026. These are reviewable planning decisions; unresolved choices are tracked in issues and do not block completing the inventory.

## Current direction

| Topic | Direction | Basis |
| --- | --- | --- |
| Product | Consenting-adult BDSM/SM/kink, play partners and overlapping romance | Explicit project direction |
| Hosting | Manager plus self-contained instances on OCI behind CloudPanel | Each owns hosting/database/storage/workers; hosts still to select |
| Identity | Independent platform subject, local memberships across instances | Contract #58 |
| Domain roles | Multiple relationship/session-scoped BDSM roles, separate from technical rights | M0 #35 |
| Plans | Free/paid readiness in core; exact prices/limits undecided | M0 #53; proposal #54 |
| Database | PostgreSQL from the foundation | Architecture recommendation for hosted tenancy |
| Frontend/backend | React/Vite + Node.js/TypeScript | Proposed for existing source reuse; [#1](https://github.com/CoyWorks/Pactaris/issues/1) |
| Product name | The app in product prose | Repository identifier remains Pactaris; name provisional |
| Repository language | English | Public project documentation; UI localization tracked separately |
| Earlier edition plan | Superseded for this scope | No Community/Cloud split or SQLite compatibility work |

## Before the scaffold

| Choice | Options / decision needed | Issue |
| --- | --- | --- |
| Backend | Node.js proposal versus Laravel or Django | [#1](https://github.com/CoyWorks/Pactaris/issues/1) |
| Authentication | Maintained app auth versus external OIDC; recovery and processor implications | [#6](https://github.com/CoyWorks/Pactaris/issues/6) |
| Source license | Maintainer-selected open-source license and reuse notices | [#50](https://github.com/CoyWorks/Pactaris/issues/50) |
| Data migration | Reuse interface only or transfer verified real records | [#2](https://github.com/CoyWorks/Pactaris/issues/2) |
| Domain and environment | Development/staging/production domains and separation | [#1](https://github.com/CoyWorks/Pactaris/issues/1) |

## Before public onboarding

| Choice | Options / decision needed | Issue |
| --- | --- | --- |
| OCI placement | Host, CPU architecture, disk/RAM budget, isolation from other workloads | [#28](https://github.com/CoyWorks/Pactaris/issues/28) |
| Process model | Supervised host processes versus app containers | [#28](https://github.com/CoyWorks/Pactaris/issues/28) |
| File storage | Private local volume versus OCI Object Storage; lifecycle/quota | [#21](https://github.com/CoyWorks/Pactaris/issues/21) |
| Email/push | Provider, sender domain, delivery policies, secrets | [#24](https://github.com/CoyWorks/Pactaris/issues/24), [#23](https://github.com/CoyWorks/Pactaris/issues/23) |
| Privacy operations | Retention, shared ownership, jurisdiction/policy review, age policy, support responsibility | [#32](https://github.com/CoyWorks/Pactaris/issues/32) |
| Safety semantics | Individual/household scope, resume participants and queued work disposition | [#11](https://github.com/CoyWorks/Pactaris/issues/11) |
| Recovery | RPO/RTO, off-host retention, restore rehearsal and key custody | [#29](https://github.com/CoyWorks/Pactaris/issues/29) |
| Registration | Invite-only pilot, quotas and criteria to open registration | [#34](https://github.com/CoyWorks/Pactaris/issues/34) |
| Monetization | Free pilot first or launch subscriptions; billing owner and entitlements | [#42](https://github.com/CoyWorks/Pactaris/issues/42) |

Keep safety, consent, personal export, leave and deletion independent of paid plans. Do not select a payment or notification provider until its operating/content policies fit the service.

## Revised foundation

Read [DOMAIN_MODEL.md](DOMAIN_MODEL.md), [PLANS.md](PLANS.md) and [INFRASTRUCTURE.md](INFRASTRUCTURE.md). These supersede generic-family framing and optional-later relationship modeling. Instance ownership of databases/files/workers and multiple contextual roles are requirements.

Recommended choices awaiting detailed ADRs: household-sponsored subscriptions, central maintained identity, metadata-only manager registry, versioned entitlement snapshots and a pull-oriented scoped agent. Illustrative Free/Plus/Pro numbers are not approved pricing or limits.

Before fleet rollout select manager placement, enrollment trust, domains, session/revocation bounds, capacity policy and recovery ownership. Before sales validate quotas/costs, sponsor changes, grace/downgrade and adult-content provider suitability. A free four-person dynamic must work.
