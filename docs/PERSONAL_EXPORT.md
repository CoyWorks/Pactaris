# Personal export

From the Profile page, request the JSON download as the account holder. The gateway checks the browser session, origin, CSRF token and a provider authentication from the last five minutes before it starts. Authentik can reauthenticate through `/auth/reauth`. Requests are throttled per account. Export stays available regardless of plan, quota or storage use.

## Version 2: complete export

The gateway streams the file directly into the response and never stores it. It asks **every** registered Instance, using an account-scoped delegation (`pactaris-account+jwt`, action `accountExport`), for every membership the account has or had there. Ended memberships are therefore included, which household placement hints alone could not provide.

| Section | Contents |
| --- | --- |
| `memberships` | Every current and ended membership: technical role, alias, dates. Household name, time zone and status only while the membership is active |
| `limits` | Own private limits |
| `tasks` | Own private and self-directed tasks |
| `documents` | Own notes, rules and protocols with every saved version and the current draft attachment (base64). Deleted documents are excluded |
| `acknowledgements` | Own rule/protocol acknowledgements |
| `routines` | Own habits, rituals and check-in definitions with revisions and progress |
| `catalog` | Own reward catalog items with versions |
| `partnerTasks`, `series` | Participant tasks and series where the person is creator or assignee, with task history |
| `personalSeries` | Own private schedules, every version |
| `checkins` | Shared check-ins the person wrote |
| `relationships` | Relationships the person participates in, with participant decisions and contextual roles |
| `agreements` | Agreement versions in those relationships, with the person's own decisions |
| `redemptions` | Reward offers and redemptions as issuer or recipient, with ledger kinds |
| `inbox` | Own task inbox notices |

Inclusion follows authorship, participation or receipt. A technical owner or administrator role never adds other members' private content. Each section pages through the Instance by a stable key in bounded batches.

The file has `version: 2`, `generatedAt`, the account presentation, `sections`, `complete` and `unavailableSources`. If an Instance cannot be reached, its records are left out, `complete` is `false` and `unavailableSources` counts the affected sources. Instance identities and addresses are never included. A failure after the download has started aborts the download rather than producing a truncated file that looks complete.

The gateway records only the account, time and completeness of each export in `pactaris.account_export_events`.

## Limits

- Larger shared media do not exist yet; only the one small draft attachment per document is included.
- Very large accounts are bounded at 2,000 pages per section and Instance; beyond that the source is reported unavailable.
- Content other participants wrote in shared records (their task submissions or decisions) appears only where it is part of a shared record the person participates in.

The earlier version 1 preview (`personalExport` household command) remains in the Instance for compatibility but is no longer used by the gateway when the complete export is available.
