# Pactaris

Operational lessons and regression requirements: [FIRST_INSTALL_NOTES.md](docs/FIRST_INSTALL_NOTES.md).

Target automated installation and one public household entry: [INSTALLER_EXPERIENCE.md](docs/INSTALLER_EXPERIENCE.md).

Update an already prepared server as root with `bash /opt/pactaris-source/update.sh`. It fetches current main and updates installed components using preserved config/backups/migrations. Older checkouts need the [one-time updater bootstrap](docs/INSTALL_UPDATE.md#one-time-updater-bootstrap). Use `--check` for a plan; applying is the default.

Historical 0.1 empty-server bootstrap, including apt dependencies (upgrade to 0.2 using LOGIN_ROLLOUT.md): [FRESH_SERVER.md](docs/FRESH_SERVER.md).

A mobile-first platform for consenting-adult BDSM, SM and kink: Dom/sub and play-partner relationships, protocols, tasks, rituals, negotiated sessions, rewards/consequences and aftercare.

**Status: connected-alpha foundations, 0.2.2-alpha.1.** The repository contains independently deployable Identity/Instance components, a central OIDC/session gateway, authorized household selection, reviewed PostgreSQL migrations and one-command updates for prepared installations. The connected alpha is not complete and is not ready for public onboarding. The confirmed product name is Pactaris.

Central-login rollout: [LOGIN_ROLLOUT.md](docs/LOGIN_ROLLOUT.md), with trust boundaries in [LOGIN_GATEWAY.md](docs/LOGIN_GATEWAY.md).

Historical direct-Instance Identity provider/application import: [OIDC blueprint instructions](docs/IDENTITY_OIDC.md).

Start with [Milestone 1](docs/MILESTONE_1.md) and [development/install instructions](docs/DEVELOPMENT.md). The operator has reported working central sign-in/local logout on the product domains. [Milestone 2](docs/MILESTONE_2.md) now covers explicit household onboarding; its first checkpoint adds [pilot Instance registration and technical permissions](docs/INSTANCE_REGISTRY.md). Household creation/invitation/leave workflows and IdP branding remain in progress or scoped, not completed.

Obedience is the functional reference for core habits, rewards/consequences, points redemption, partner updates/chat and progress charts. See [the baseline mapping](docs/OBEDIENCE_BASELINE.md); implement original code and presentation.

## Core model

A household is a private dynamic space, not a family/residence unit. It may be a Dom/sub pair, a Dom/Dom/sub/sub group or another explicitly agreed configuration. Members can hold several roles and overlapping BDSM/romantic relationships. Someone can be dominant to A and submissive/bottom to B simultaneously. Technical administrator rights remain separate from these roles.

Independent accounts can join multiple households, including households on different instances. Relationship roles, technical permissions, standing, billing sponsorship and platform operations are distinct concepts.

## Hosted infrastructure

One public hosted product runs on operator-managed instances, starting on OCI behind CloudPanel. Each instance owns its application hosting, PostgreSQL database, private storage, workers and backups and hosts multiple isolated households.

A server manager registers instances and manages placement, health, capacity and controlled lifecycle operations. It holds operational/identity/entitlement metadata, not a shared database of intimate tenant content. Contracts must exist in the foundation, even while only one instance is deployed.

This supersedes the historical SQLite Community/Cloud self-hosting plan. Project-owned source is proprietary/all rights reserved; see [LICENSE.txt](LICENSE.txt) and [#50](https://github.com/CoyWorks/Pactaris/issues/50). No general permission for reuse, modification, redistribution, self-hosting or commercial exploitation is granted. Third-party licenses, applicable law and GitHub platform terms still apply. The owner plans to make the repository private later; it remains public for now.

Central identity must offer Google, Apple and local verified email/password accounts, with OIDC sessions for instances. Select a maintained identity broker/service that supports all three; OIDC alone does not supply local account management.

## Implementation stack

| Layer | Proposal |
| --- | --- |
| Frontend | React/Vite/TypeScript mobile-first PWA |
| Instance backend | Node.js/TypeScript, Express, modular domain services |
| Data | Private PostgreSQL per instance, Drizzle migrations and tenant RLS |
| Jobs | Durable local worker/scheduler and transactional outbox |
| Files | Private local/OCI storage adapter with isolated instance credentials |
| Notifications | In-app, transactional email and opt-in Web Push per user/device |
| Management | Separate server-manager/agent contract, identity/placement and entitlement integration |
| Hosting | OCI, CloudPanel/NGINX TLS proxy, supervised services or isolated app containers |

Node.js/TypeScript with Express, PostgreSQL/Drizzle and systemd is the agreed runtime/deployment direction. Exact versions and the identity product remain to be recorded in [#1](https://github.com/CoyWorks/Pactaris/issues/1). Compare Node.js, Laravel/PHP and Django/Python in [ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Independently installable applications

Identity and Instance are separate applications with independent install/update/configuration/data lifecycles. They may initially share the CloudPanel host, but must also work on separate servers behind another proxy. Default HTTPS ingress ports are 9443 for Identity and 9444 for every Instance; actual bind addresses/origins/ports are configuration. CloudPanel administration stays at its existing 8443. See [the concrete proxy map](docs/INFRASTRUCTURE.md).

## Free and paid

Build versioned entitlements into M0 ([#53](https://github.com/CoyWorks/Pactaris/issues/53)), even if only Free is enabled initially. The illustrative Free plan supports four people. Paid plans may expand members, active tasks, schedules, storage, automation, templates, planning, insights and integrations. Prices and exact limits remain proposals in [PLANS.md](docs/PLANS.md).

Basic relationship diversity and multiple contextual roles, consent, limits, safewords, pause/stop, privacy controls, MFA, personal export, leave and deletion stay available in every plan. Downgrade/nonpayment does not delete content, evict members or override agreements.

## First usable scope

Accounts; explicit invitations; technical permissions; accepted multi-role relationship graph; negotiation/consent; pause and stop; protocols; tasks/recurrence; check-ins and aftercare; play-session planning; optional rewards/agreed consequences; private attachments; inbox/push/email; audit; export/delete; profile and dynamic settings.

First slice: **sign in → join a dynamic explicitly → define accepted relationships/roles → negotiate consent → assign/complete a task → stop → export/leave**. Validate a pair, four-person group and contextual switch before broader feature expansion.

The first working slice includes infrastructure: central/main/internal instance service boundaries, minimum registration/status and GitHub-based install/update/status tooling (#56), with a preserving update to a second pinned version. See [INSTALL_UPDATE.md](docs/INSTALL_UPDATE.md).

## English-first messages and locales

All visible system text is resolved from stable translation keys/shortcodes through language files from the first implementation. English is the only initial language; no hardcoded English/Dutch UI prose in application logic. Cover errors, accessibility, email, push, audit presentation, central login and server manager. Language, regional formatting locale and timezone are separate preferences. Additional translations ship as validated packs. See [INTERNATIONALIZATION.md](docs/INTERNATIONALIZATION.md) and #44 (M0).

## Planning

- [Domain model](docs/DOMAIN_MODEL.md): multiple contextual BDSM roles, graph, negotiation and sessions.
- [Free/paid matrix](docs/PLANS.md): illustrative capacities, sponsorship, entitlements and downgrade rules.
- [Infrastructure](docs/INFRASTRUCTURE.md): installer, enrollment, manager, independent instances, identity and placement.
- [Feature inventory](docs/FEATURE_INVENTORY.md): all 65 work items.
- [Roadmap](docs/ROADMAP.md) and [tracker #51](https://github.com/CoyWorks/Pactaris/issues/51): delivery order and gates.
- [Architecture](docs/ARCHITECTURE.md), [open decisions](docs/DECISIONS.md) and [existing Site assessment](docs/EXISTING_SITE.md).
- [Contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).

## Safety and privacy

Participation is explicit and reversible. No administrator/sponsor can accept another person's consent or remove their personal pause. Apply tenant/resource/relationship visibility in APIs, files, graph views, audit, exports and jobs. Personal-private content does not become readable by a household admin.

No covert tracking, blackmail, forced participation, punitive withdrawal or device punishment. Recorded consent/limits cannot establish real-world consent or guarantee emergency help. Safety state is always subject to truthful server acknowledgement.

## Existing prototype and development

[Pactaris](https://consent-households.coyseinri.chatgpt.site), version 4, is a reference only. This is a new product with empty production databases; no legacy users, accounts or household content will be migrated. This documentation update does not change that Site or deploy OCI services. See the source assessment for verified behavior and gaps.

Installer/updater/status entry points now exist with a read-only plan default; host application remains experimental and unverified. See docs/DEVELOPMENT.md for prerequisites, refusal/recovery behavior and limitations. Google/Apple and live provider acceptance, full domain workflows and updater acceptance and complete rights review remain open. The proprietary licensing direction and clean start are decided.
