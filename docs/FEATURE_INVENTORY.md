# Feature inventory

All entries describe proposed work, not delivered functionality. The app centers consenting-adult BDSM/SM/kink dynamics, play partners and overlapping romance. Contextual role diversity is core, not a premium feature.

61 work items plus [tracker #51](https://github.com/CoyWorks/Pactaris/issues/51). Phase/area tags are in titles; native GitHub milestone objects are not implied.

| Phase | Count |
| --- | ---: |
| M0 | 17 |
| M1 | 15 |
| Launch | 12 |
| Later | 12 |
| Good-to-have | 1 |
| Wish | 4 |

M1 alone does not allow open registration. Complete applicable Launch gates; second-instance public onboarding needs #62. Paid checkout is later but entitlement/usage contracts are M0. Relationship modeling #35 has moved from Later to M0.

| Issue | Phase | Area | Scope |
| --- | --- | --- | --- |
| [#1](https://github.com/CoyWorks/Pactaris/issues/1) | M0 | Architecture | Choose the hosted application stack and record the deployment boundary |
| [#2](https://github.com/CoyWorks/Pactaris/issues/2) | M0 | Migration | Audit and map the existing ChatGPT Site before porting |
| [#3](https://github.com/CoyWorks/Pactaris/issues/3) | M0 | Foundation | Create the modular application scaffold and development environment |
| [#4](https://github.com/CoyWorks/Pactaris/issues/4) | M0 | Tenancy | Design PostgreSQL users, households and membership-scoped records |
| [#5](https://github.com/CoyWorks/Pactaris/issues/5) | M0 | Tenancy | Enforce tenant isolation in API, database, files and background jobs |
| [#6](https://github.com/CoyWorks/Pactaris/issues/6) | M0 | Accounts | Implement independent accounts, verification and secure sessions |
| [#7](https://github.com/CoyWorks/Pactaris/issues/7) | Launch | Accounts | Add MFA, recovery codes and device/session management |
| [#8](https://github.com/CoyWorks/Pactaris/issues/8) | M0 | Households | Build explicit household creation, invitations and switching |
| [#9](https://github.com/CoyWorks/Pactaris/issues/9) | M0 | Permissions | Implement server-side roles and resource visibility policies |
| [#10](https://github.com/CoyWorks/Pactaris/issues/10) | M0 | Consent | Create versioned agreements, limits and individual consent records |
| [#11](https://github.com/CoyWorks/Pactaris/issues/11) | M0 | Safety | Implement pause, safeword and emergency-stop state transitions |
| [#12](https://github.com/CoyWorks/Pactaris/issues/12) | M0 | Audit | Add privacy-aware audit events and transactional domain mutations |
| [#13](https://github.com/CoyWorks/Pactaris/issues/13) | M0 | Engineering | Set up CI and real tenant/safety regression coverage |
| [#14](https://github.com/CoyWorks/Pactaris/issues/14) | M1 | PWA | Port the mobile interface and implement safe PWA caching |
| [#15](https://github.com/CoyWorks/Pactaris/issues/15) | M1 | Dashboard | Build household and personal dashboards with scoped activity |
| [#16](https://github.com/CoyWorks/Pactaris/issues/16) | M1 | Rules | Implement rules and protocols with versions and acknowledgement |
| [#17](https://github.com/CoyWorks/Pactaris/issues/17) | M1 | Tasks | Implement task assignment, completion, review and dispute states |
| [#18](https://github.com/CoyWorks/Pactaris/issues/18) | M1 | Scheduling | Build reliable recurrence, scheduler, outbox and job processing |
| [#19](https://github.com/CoyWorks/Pactaris/issues/19) | M1 | Check-ins | Implement rituals and configurable check-in responses |
| [#20](https://github.com/CoyWorks/Pactaris/issues/20) | M1 | Rewards | Implement rewards, agreed consequences and a reversible points ledger |
| [#21](https://github.com/CoyWorks/Pactaris/issues/21) | M1 | Files | Create private upload storage with authorization, validation and cleanup |
| [#22](https://github.com/CoyWorks/Pactaris/issues/22) | M1 | Notifications | Build an in-app inbox and per-user notification preferences |
| [#23](https://github.com/CoyWorks/Pactaris/issues/23) | M1 | Notifications | Implement Web Push subscriptions per user and device |
| [#24](https://github.com/CoyWorks/Pactaris/issues/24) | M1 | Email | Configure transactional email and delivery operations |
| [#25](https://github.com/CoyWorks/Pactaris/issues/25) | M1 | Privacy | Build scoped personal and household data exports |
| [#26](https://github.com/CoyWorks/Pactaris/issues/26) | M1 | Privacy | Implement leave, removal, ownership transfer and data deletion |
| [#27](https://github.com/CoyWorks/Pactaris/issues/27) | M1 | Settings | Add profile, household settings and configurable terminology |
| [#28](https://github.com/CoyWorks/Pactaris/issues/28) | Launch | Operations | Document and implement OCI deployment behind CloudPanel |
| [#29](https://github.com/CoyWorks/Pactaris/issues/29) | Launch | Operations | Implement encrypted backups and verify disaster recovery |
| [#30](https://github.com/CoyWorks/Pactaris/issues/30) | Launch | Operations | Add privacy-safe monitoring, health alerts and capacity limits |
| [#31](https://github.com/CoyWorks/Pactaris/issues/31) | Launch | Security | Run public-launch security, isolation and concurrency acceptance tests |
| [#32](https://github.com/CoyWorks/Pactaris/issues/32) | Launch | Privacy | Complete the hosted-service privacy and acceptable-use launch review |
| [#33](https://github.com/CoyWorks/Pactaris/issues/33) | Launch | Administration | Build limited platform administration and abuse handling |
| [#34](https://github.com/CoyWorks/Pactaris/issues/34) | Launch | Release | Run an invite-only pilot and plan the existing-site cutover |
| [#35](https://github.com/CoyWorks/Pactaris/issues/35) | M0 | Dynamics | Model multiple relationship-scoped BDSM roles and relationship graphs |
| [#36](https://github.com/CoyWorks/Pactaris/issues/36) | Later | Permissions | Add revocable, scoped and expiring delegation |
| [#37](https://github.com/CoyWorks/Pactaris/issues/37) | Later | Templates | Create versioned household and workflow templates |
| [#38](https://github.com/CoyWorks/Pactaris/issues/38) | Later | Calendar | Add planner views and revocable private ICS feeds |
| [#39](https://github.com/CoyWorks/Pactaris/issues/39) | Later | Automation | Build a constrained event-based automation studio |
| [#40](https://github.com/CoyWorks/Pactaris/issues/40) | Later | Search | Add permission-filtered search, tags and saved filters |
| [#41](https://github.com/CoyWorks/Pactaris/issues/41) | Later | Insights | Provide opt-in household summaries and wellbeing-oriented trends |
| [#42](https://github.com/CoyWorks/Pactaris/issues/42) | Later | Billing | Evaluate paid hosted subscriptions for BDSM dynamics |
| [#43](https://github.com/CoyWorks/Pactaris/issues/43) | Later | Integrations | Design scoped API tokens and signed outbound webhooks |
| [#44](https://github.com/CoyWorks/Pactaris/issues/44) | Later | Accessibility | Add Dutch/English localization and configurable regional formats |
| [#45](https://github.com/CoyWorks/Pactaris/issues/45) | Good-to-have | Personalization | Add safe themes, dashboard layouts and custom profile fields |
| [#46](https://github.com/CoyWorks/Pactaris/issues/46) | Wish | Wellbeing | Explore private journaling, reflections and aftercare check-ins |
| [#47](https://github.com/CoyWorks/Pactaris/issues/47) | Wish | Mobile | Evaluate a thin mobile wrapper after validating the PWA |
| [#48](https://github.com/CoyWorks/Pactaris/issues/48) | Wish | Security | Assess end-to-end encryption for narrowly scoped private content |
| [#49](https://github.com/CoyWorks/Pactaris/issues/49) | Wish | Integrations | Evaluate opt-in calendar, messaging and external app integrations |
| [#50](https://github.com/CoyWorks/Pactaris/issues/50) | M0 | Governance | Choose the source license and contribution policy |
| [#52](https://github.com/CoyWorks/Pactaris/issues/52) | M1 | Play sessions | Add negotiated play sessions, check-ins and aftercare |
| [#53](https://github.com/CoyWorks/Pactaris/issues/53) | M0 | Plans | Create versioned plan entitlements and atomic usage enforcement |
| [#54](https://github.com/CoyWorks/Pactaris/issues/54) | Later | Plans | Validate the free and paid feature matrix against BDSM use cases |
| [#55](https://github.com/CoyWorks/Pactaris/issues/55) | M0 | Infrastructure | Define the server-manager control plane and self-contained instance contract |
| [#56](https://github.com/CoyWorks/Pactaris/issues/56) | Launch | Infrastructure | Build an idempotent instance installer with preflight and rollback |
| [#57](https://github.com/CoyWorks/Pactaris/issues/57) | Launch | Infrastructure | Implement secure instance enrollment and the server-manager inventory |
| [#58](https://github.com/CoyWorks/Pactaris/issues/58) | M0 | Infrastructure | Design platform identity, household placement and instance routing |
| [#59](https://github.com/CoyWorks/Pactaris/issues/59) | Launch | Infrastructure | Add instance maintenance, staged upgrades, drain and retirement |
| [#60](https://github.com/CoyWorks/Pactaris/issues/60) | Later | Infrastructure | Implement complete household relocation between instances |
| [#61](https://github.com/CoyWorks/Pactaris/issues/61) | Later | Billing | Synchronize subscription entitlements to instances safely |
| [#62](https://github.com/CoyWorks/Pactaris/issues/62) | Launch | Infrastructure | Verify multi-instance isolation, routing and manager outage recovery |

## Specifications

- [Domain model](DOMAIN_MODEL.md): multi-role graph, negotiation, session scope and visibility.
- [Plans](PLANS.md): proposed Free/Plus/Pro capacities, sponsorship and safe downgrade behavior.
- [Infrastructure](INFRASTRUCTURE.md): manager, installer, independent instances, routing and lifecycle.

## Boundaries

No general-family/residence assumption, single-global Dom/sub field, automatic authority from relationship labels or cross-household private graph sharing. No public self-hosted edition, SQLite portability, covert tracking, blackmail, forced participation, punitive withdrawal, public compliance rankings or device punishment.

Safety, consent, privacy, basic MFA, personal export, leave and deletion remain available in every plan. Public marketplaces, predictive relationship scoring and offline mutation synchronization are outside MVP.
