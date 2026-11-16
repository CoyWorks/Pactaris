# Project instructions

Build a public, mobile-first BDSM/SM/kink platform for consenting adults, Dom/sub/top/bottom/switch dynamics and play partners, with overlapping romantic relationships. Use “the app” or “the project” in product prose until the product name is confirmed. Pactaris is the repository identifier.

## Current scope

- One logical public product on OCI behind CloudPanel, with a manager and self-contained operator-managed instances. Each instance owns hosting, PostgreSQL, private storage, workers and backups and hosts multiple isolated households.
- A household is a private dynamic space, not a family/residence model. Support pairs and groups, multiple simultaneous contextual roles and overlapping relations; no global Dom/sub enum or automatic all-to-all graph.
- A person can be Dom to A and sub/bottom to B. Technical RBAC, dynamic role, standing, billing sponsorship and platform authority are separate.
- Core M0 includes relationship graph #35, versioned entitlements #53 and instance/identity/placement contracts #55/#58.
- Accounts can join households on different instances. Verify subject/audience and current local membership; manager metadata must not become a shared tenant-content database.
- The current hosted direction supersedes the historical Community/Cloud and SQLite self-hosting plan. Do not introduce edition flags or SQLite portability as default scope.
- Read README.md, docs/ARCHITECTURE.md, docs/DOMAIN_MODEL.md, docs/PLANS.md, docs/INFRASTRUCTURE.md, docs/EXISTING_SITE.md and the target issue before implementation.
- The proposed React/Vite + Node.js/TypeScript + PostgreSQL/Drizzle stack still requires the architecture decision in issue #1.

## Consent and privacy

- Make participation explicit and reversible. Never autoaccept invitations or agreements.
- Every participant can pause, stop, revoke consent and leave. An administrator cannot override another person's withdrawal or personal pause.
- Separate global identity, household membership, permissions, standing and relationships.
- Enforce tenant/resource authorization in API reads/writes, jobs, files, search, notifications and exports. Household role names are not permissions.
- Personal-private data is not accessible merely because someone administers the household.
- Basic relationship diversity, multiple contextual roles, negotiation, limits, safewords, safety, privacy, MFA, personal export, leave and deletion are not paywalled.
- Paid tiers expand capacity and convenience. Proposed numerical quotas/prices require validation. Downgrade never deletes content, evicts members, overrides agreement or blocks safe exit.
- Local safety under valid sessions must not depend on a fresh manager call. Stop controls cannot succeed offline without server acknowledgement.
- No covert tracking, hidden monitoring, blackmail, forced participation or device punishment features.

## Development

- Propose a plan before large changes. Work in small buildable issues with clear acceptance criteria and dependencies.
- Inspect existing code before proposing a port. Distinguish verified behavior from schema fields, prototypes and historical claims.
- Keep domain services modular and deployment Docker-friendly. Avoid unnecessary services.
- Use transactions, unique operation keys and a durable outbox/worker for critical side effects.
- Test real tenant boundaries and safety races; re-check consent and authorization when jobs execute. Include pair/four-person/contextual switch fixtures, independent instance stores/audiences, manager outage and plan downgrade.
- Never commit secrets or real household data. Use English repository documentation and synthetic fixtures.
- Do not change or deploy the existing ChatGPT Site during planning. Review the cutover issue before migration/publication.
