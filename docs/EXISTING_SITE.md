# Existing Site assessment

Inspected 16 November 2026. Product reference: [The app](https://consent-households.coyseinri.chatgpt.site), Site version 4. Source checkout HEAD: `23d17151bbc727b07ddc5ff6f3ce3fe81832d9ac`.

This is a bounded source inspection, not a complete security audit or live functional verification. The source repository HEAD was inspected; correspondence with the deployed version must be verified during [#2](https://github.com/CoyWorks/Pactaris/issues/2). Live database rows were not read. Historical zip versions are not used as authoritative evidence.

## Verified source structure

React/TypeScript, Vinext/Vite, Drizzle SQLite/D1 schema and migrations, Cloudflare Worker runtime and R2 bindings. Account resolution reads platform-provided ChatGPT identity headers. The new repository was empty at the start of this planning pass.

| Area | Source evidence | Porting direction |
| --- | --- | --- |
| Dashboard and household switcher | `app/dashboard.tsx`, `app/api/server.ts` | Reuse interaction design; replace aggregate data responses with bounded policy-filtered endpoints |
| Users, households and memberships | `db/schema.ts`, viewer resolution | Adapt to PostgreSQL constraints and independent authenticated identity |
| Roles and permissions | Schema plus `hasPermission` | Rebuild stable policy evaluation; role-name shortcut must not carry over |
| Invitations | Schema and acceptance during viewer resolution | Rebuild explicit token-bound accept/decline flow |
| Rules/protocols | Content schema and Studio actions | Adapt versioning, acknowledgement and resource visibility |
| Tasks and recurrence | Task routes and series/occurrence schema | Adapt lifecycle; rebuild durable recurrence beyond initial planning window |
| Rituals/check-ins | Schema and Studio scheduling/review actions | Adapt using shared recurrence and privacy policies |
| Rewards/points | Ledger schema and routes | Adapt with transactional unique operations and real linked reversals |
| Consent and limits | Agreements, acceptance and limit actions | Rebuild explicit initial acceptance and centralized guards |
| Pause/emergency stop | Safety route and household pause flag | Rebuild individual holds and resume policy; test concurrent worker behavior |
| Uploads | File routes, MIME checks and R2 storage | Replace storage adapter; enforce parent authorization and streaming/quarantine controls |
| Calendar | Token-hashed feed schema and ICS route | Adapt later with access revocation and caching limitations documented |
| Automation | Rule/action schema and inline point-award execution | Defer general Studio; rebuild reliable event processing before expanding |
| Notifications | Preferences/history and service-worker registration | Build real delivery pipeline; production Push subscription storage/sender not found in inspected schema/routes |
| Export | Member/household JSON export route | Rebuild consistent field/resource filtering and large export jobs |
| PWA | Manifest and `public/sw.js` | Replace broad GET caching with public static allowlist |
| Isolation tests | `tests/household-isolation.test.mjs` | Retain useful membership logic; add real API/database policy tests |
| Delegation/overrides | Schema tables | Requirements exist; schema presence does not establish a complete working UI/enforcement path |

## Migration priorities

1. Replace platform identity headers with verified application sessions. Public requests must never be able to authenticate themselves through those headers.
2. Replace automatic invitation acceptance and preaccepted initial agreements with explicit user choices.
3. Unify authorization across private content, list/detail routes, parent objects, attachments and exports.
4. Implement safety transitions that cannot let an administrator override an individual's pause or withdrawn consent.
5. Introduce transactions, durable jobs, unique operation keys and real recurrence scheduling.
6. Replace Worker/D1/R2-specific infrastructure and broad service-worker caching.
7. Add hosted operations: email, push, backups/restore, monitoring, incident handling and deletion lifecycle.

The existing Site is a useful feature and visual reference. It is not evidence that all declared schema concepts are fully implemented or safe to expose as a public service.

## Data cutover

First decide whether the existing Site contains data that should be transferred. Do not assume a clean demo or migrate data without mapping verified account ownership and tenant boundaries. If migration is needed, specify versioned export/import, file transfer, dry-run reconciliation, read-only cutover window and rollback in [#2](https://github.com/CoyWorks/Pactaris/issues/2) and [#34](https://github.com/CoyWorks/Pactaris/issues/34).
