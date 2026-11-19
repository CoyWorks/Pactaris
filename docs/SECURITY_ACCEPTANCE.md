# Public-launch security acceptance (#31)

This maps the #31 criteria to automated evidence in the repository and to the checks that still need the deployed host. Passing CI is not launch approval: open registration stays closed until every row marked *pending* has recorded evidence and the remaining risks are accepted.

## Evidence matrix

| Criterion | Automated evidence | Status |
| --- | --- | --- |
| Unrelated households, multi-household accounts, restricted participants | `tests/postgres.integration.ts`: two Instances, account in several households, unrelated household denial, participant-only relationships/agreements/tasks, admin exclusion from private content | Automated |
| IDOR | Integration: wrong household, wrong Instance, wrong membership generation, foreign resource IDs and forged actor fields fail closed in every module | Automated |
| CSRF and Origin | `tests/gateway.test.ts` enumerates **every** gateway `POST`/`PUT`/`PATCH`/`DELETE` route under `/api/` and proves each rejects a session without exact Origin and CSRF proof | Automated |
| XSS | All user content renders as escaped React text; CSP `default-src 'self'` without inline scripts on every response (asserted per API route); the i18n checker rejects visible literals | Automated (no browser fuzzing) |
| Session fixation | Login rotates the session; one-time login binding, replayed callback and wrong browser rejected (`tests/gateway.test.ts`) | Automated |
| Proxy headers | Forged identity/role headers ignored; host poisoning rejected; `trust proxy` limited to configured addresses | Automated |
| Uploads | Draft attachments: size/type bounds, owner-only download, lifecycle cleanup (integration) | Automated (only small text attachments exist) |
| Export leaks | Complete export includes only own/participant records and no Instance identities (integration) | Automated |
| Service-worker cache isolation | Worker never caches private requests; API responses `no-store` (asserted for every route) | Automated; device check pending in #77 |
| Pause/revoke races against workers | Scheduler and consent integration tests serialize pause, revocation and departure against worker batches | Automated |
| Duplicate ledger operations | Point reservation, task-reward and redemption replay/race tests in PostgreSQL | Automated |
| Restore and revocation replay | Fenced restore replay and account-erasure replay (integration) | Automated; host drill pending |
| Bounded load and polling | `scripts/load_probe.py` (below) | **Pending** host measurement |
| Query plans, queue recovery, large export | — | **Pending** host measurement |
| Manager outage, wrong audience, downgrade, Instance compromise boundaries | Integration covers wrong audience, replay, private route failure, downgrade and the restrictive outage path | Automated; second-instance evidence pending in #62 |

## Load probe

`scripts/load_probe.py` simulates visible clients polling the same read endpoints as the app (`/api/session`, `/api/households`) for a bounded time. It sends only `GET` requests, accepts at most 200 clients for at most 15 minutes, and reads the session cookie of a **synthetic test account** from the environment so it never appears in shell arguments.

```bash
export PACTARIS_LOAD_SESSION='__Host-pactaris-session=<synthetic test session>'
python3 scripts/load_probe.py --origin https://pactaris.app --clients 50 --seconds 300 --interval 60
python3 scripts/load_probe.py --origin https://pactaris.app --clients 50 --seconds 120 --interval 60 --burst
```

The first run spreads clients over the polling interval; `--burst` starts them together to model a reconnect burst. Each prints one JSON report with status counts and p50/p95/p99 latency, and exits non-zero if any request did not return 200. Run it from outside the deployment network while watching [local monitoring](OPERATIONS_MONITORING.md) for CPU, pool saturation and worker heartbeat. Rate limits may answer 429 under heavy load; record that as a finding rather than raising limits during the run.

Record for each run: commit, client count, interval, burst flag, report JSON, and the monitor output before and after. Remove the synthetic session afterwards.

## Before enabling open registration

- Record the pending host measurements above and the #77 live checks.
- Run an independent review or penetration test of the deployed pilot.
- List remaining risks with an owner decision for each.
