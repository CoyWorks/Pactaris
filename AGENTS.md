# Project instructions

Build a public, centrally hosted, mobile-first household/dynamic management app. Use “the app” or “the project” in product prose until the product name is confirmed. Pactaris is the repository identifier.

## Current scope

- One hosted service on OCI behind CloudPanel, with independent accounts and multiple isolated households.
- The current hosted direction supersedes the historical Community/Cloud and SQLite self-hosting plan. Do not introduce edition flags or SQLite portability as default scope.
- Read README.md, docs/ARCHITECTURE.md, docs/EXISTING_SITE.md and the target issue before changing implementation.
- The proposed React/Vite + Node.js/TypeScript + PostgreSQL/Drizzle stack still requires the architecture decision in issue #1.

## Consent and privacy

- Make participation explicit and reversible. Never autoaccept invitations or agreements.
- Every participant can pause, stop, revoke consent and leave. An administrator cannot override another person's withdrawal or personal pause.
- Separate global identity, household membership, permissions, standing and relationships.
- Enforce tenant/resource authorization in API reads/writes, jobs, files, search, notifications and exports. Household role names are not permissions.
- Personal-private data is not accessible merely because someone administers the household.
- Safety, personal export, leave and deletion are not paywalled.
- No covert tracking, hidden monitoring, blackmail, forced participation or device punishment features.

## Development

- Propose a plan before large changes. Work in small buildable issues with clear acceptance criteria and dependencies.
- Inspect existing code before proposing a port. Distinguish verified behavior from schema fields, prototypes and historical claims.
- Keep domain services modular and deployment Docker-friendly. Avoid unnecessary services.
- Use transactions, unique operation keys and a durable outbox/worker for critical side effects.
- Test real tenant boundaries and safety races; re-check consent and authorization when jobs execute.
- Never commit secrets or real household data. Use English repository documentation and synthetic fixtures.
- Do not change or deploy the existing ChatGPT Site during planning. Review the cutover issue before migration/publication.
