# The app

A mobile-first platform for consensual household dynamics, shared protocols, tasks, rituals and accountability.

**Status: discovery and planning.** This repository contains the product scope, architecture proposal and implementation backlog. It does not contain a runnable application yet. The repository identifier is `CoyWorks/Pactaris`; the product name remains provisional.

## Hosted from the core

The project will run as one public service on OCI behind CloudPanel. People have independent accounts and can join multiple isolated households with different roles in each. A household is the tenant boundary.

The current direction supersedes the earlier Community/Cloud and SQLite self-hosting plan. There is one hosted product scope. Open-source licensing is a separate decision ([#50](https://github.com/CoyWorks/Pactaris/issues/50)).

## Core principles

- Explicit, versioned and revocable consent. Acknowledgement is separate from consent.
- Any participant can pause or stop. Administrators cannot override another person's withdrawal.
- Separate account identity, household membership, technical permissions, standing and relationships.
- Tenant and resource authorization on every API, file, export and background job.
- Private content stays private; household administration does not imply access to personal-private notes.
- Personal export, leave, deletion and safety remain available independently of subscription status.
- No covert tracking, forced monitoring, blackmail features or automated device punishment.

## Proposed stack

| Layer | Proposal |
| --- | --- |
| Frontend | React, Vite, TypeScript, mobile-first PWA |
| Backend | Node.js/TypeScript with Express and modular domain services |
| Database | PostgreSQL with Drizzle migrations and row-level security |
| Jobs | Durable PostgreSQL-backed worker and transactional outbox |
| Files | Private storage adapter; local volume or OCI Object Storage to be selected |
| Notifications | In-app inbox, transactional email and opt-in Web Push per user/device |
| Hosting | OCI VM, CloudPanel/NGINX TLS proxy, supervised application/worker processes |

This is a recommendation for review, not a completed technology decision. See [architecture options](docs/ARCHITECTURE.md) and [#1](https://github.com/CoyWorks/Pactaris/issues/1).

## First usable scope

Accounts and verification; explicit household invitations; owner/admin/participant permissions; consent, pause and emergency stop; rules/protocols; tasks and recurrence; rituals/check-ins; optional points/rewards and agreed consequences; private attachments; notifications; audit; export/deletion; profile and household settings.

Start with one complete vertical slice: **sign in → create/join household → agree explicitly → assign/complete a task → pause → export/leave**. Add broader modules after this slice has real isolation and safety tests.

Follow the [delivery tracker](https://github.com/CoyWorks/Pactaris/issues/51) for the complete backlog and phase checklist.

## Planning documents

- [Feature inventory](docs/FEATURE_INVENTORY.md): all priorities and issue links.
- [Roadmap](docs/ROADMAP.md): build order and release gates.
- [Architecture](docs/ARCHITECTURE.md): Node.js, PHP and Python comparison; tenancy and hosting proposal.
- [Existing Site assessment](docs/EXISTING_SITE.md): inspected source and migration gaps.
- [Open decisions](docs/DECISIONS.md): choices required before implementation and launch.
- [Contributing](CONTRIBUTING.md): issue and pull-request expectations.
- [Security reporting](SECURITY.md): disclosure route and current limitations.

## Existing prototype

The existing ChatGPT Site is [The app](https://consent-households.coyseinri.chatgpt.site), version 4. It remains the product reference. Source was inspected on 16 November 2026; this planning pass did not modify the Site, read live household data or deploy to OCI.

## Development status

There are no install or deployment commands yet. Implementation begins with [#1](https://github.com/CoyWorks/Pactaris/issues/1), [#2](https://github.com/CoyWorks/Pactaris/issues/2), [#50](https://github.com/CoyWorks/Pactaris/issues/50) and [#3](https://github.com/CoyWorks/Pactaris/issues/3). Select supported runtime versions and lock dependencies when building the scaffold.

A public repository does not itself grant an open-source license. License selection is pending; see [#50](https://github.com/CoyWorks/Pactaris/issues/50).
