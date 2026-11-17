# Efficient development and verification

Use targeted checks during development, one full final verification for code changes, and compact results. Reduce repeated work and output without weakening authorization, privacy, database or safety coverage.

- Read relevant files, functions and diffs first. Reuse established context; reread only when it is missing, has changed or is needed to verify an assumption.
- Group related edits into a coherent, buildable change. Run the affected tests while editing; run the required full checks once before publishing that change. Use one CI checkpoint rather than publishing every small intermediate edit.
- Save verbose command output to a temporary log. Report the command outcome, test counts and any material limits. On failure, inspect and share only the relevant error and surrounding context; expand the log only when diagnosis requires it. Never expose secrets or real user data.
- Do not repeat passing checks without a relevant code/configuration change, a failure or a concrete unresolved concern. Documentation-only changes normally need diff and link review rather than application test suites. Required repository/CI gates still apply.
- Keep meaningful real PostgreSQL, tenant-isolation, authorization, transaction and concurrency tests for changes that affect those behaviors. Token efficiency must not replace them with mocks or source-pattern assertions, or allow skipped integration tests to be reported as passed.
- Match new tests to the risk and behavior being changed. Avoid tests that merely mirror implementation details or add no useful regression protection.
- Keep progress and completion reports concise: what changed, what was verified, and what remains unverified. Avoid dumping full files, successful logs or previously established explanations.

See [CONTRIBUTING.md](../CONTRIBUTING.md) for contribution requirements. The checkpoints below are historical and retain their original verification limits.

# Current login slice — 0.2.0-alpha.1

Read [LOGIN_GATEWAY.md](LOGIN_GATEWAY.md) and [LOGIN_ROLLOUT.md](LOGIN_ROLLOUT.md) for the central OIDC/session gateway, migration/backup roles and real-host rollout. The sections below describe the original 0.1 foundation checkpoint and its historical limits. Parent issues remain open for their wider criteria.

# Foundation checkpoint — 0.1.0-alpha.1

This first code checkpoint starts milestone 1; it does not complete the connected alpha. Read MILESTONE_1.md for remaining gates.

## Available now

- Independent authentik candidate Compose definition and Node/Express Instance application.
- English keyed status screen, validated public/private endpoint configuration and locale/timezone formatting.
- Liveness, PostgreSQL-backed readiness, redacted status and a fail-closed session endpoint.
- Foundation worker heartbeat. This is not yet a durable job scheduler.
- Component-selecting install/update/status tooling with a read-only plan default, staged pinned source, separate locks/configuration and application health/recovery gates.

No OIDC login, household data API, durable task processing, manager enrollment or Google/Apple callback integration is implemented yet. `/api/session` returns 401 regardless of proxy identity headers. The status page explicitly says sign-in is not enabled. Do not expose this foundation as a production household service.

## Build and test compilation boundaries

`npm run build` emits deployable apps/packages/scripts through `tsconfig.build.json`; it does not compile tests into the release. `npm run typecheck` uses the broader `tsconfig.json` and checks all tests. Keep long integration scenarios in bounded async functions instead of extending one unbounded control-flow graph: TypeScript stack exhaustion was observed on the OCI host and reproduced locally with a 512 KiB V8 stack. CI retains a reduced-stack all-source typecheck, a clean-artifact test exclusion check and actual PostgreSQL/HTTPS execution. Do not exclude tests from typechecking or remove integration assertions to make a deployment build pass.

## Local checks

Prerequisites: Node.js 24, npm and Python 3.12 or newer on Linux. Dependencies are pinned in package-lock.json.

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run check
npm run build
```

For a local loopback-only development run, copy config/instance.development.example.json to an ignored `instance.local.json`, replace the database URL with a private test database, then:

```bash
APP_CONFIG="$PWD/instance.local.json" npm run dev:instance -- --development
```

The page is at the configured origin. Without PostgreSQL it remains live but readiness returns 503. Development HTTP is explicitly restricted to loopback; deployment mode requires TLS. No service worker caches authenticated pages or APIs in this checkpoint.

## Installer planning

Use a full operator-approved 40-character GitHub commit SHA, not a mutable branch. `REVISION` below must be set to the intended commit. Config examples are documentation data; replace example origins, credentials, IDs and TLS paths before application.

```bash
bash install.sh --component identity --root /opt/pactaris --config /secure/identity.json --revision "$REVISION"
bash install.sh --component instance --root /opt/pactaris --config /secure/instance.json --revision "$REVISION"
```

Without `--apply`, these only validate basic configuration and print a redacted plan; they do not create directories or run service commands. Identity and Instance use separate `/opt/pactaris/<component>` state. Paths used in systemd must contain only the supported simple absolute path characters; the apply root and ancestors must be root-owned and not group/world-writable or symlinked.

For fresh-server apt, runtime, database and TLS preparation, follow [FRESH_SERVER.md](FRESH_SERVER.md).

## Experimental host application

Host application is not yet verified on a real systemd/Docker/PostgreSQL host. Use only an isolated test VM with synthetic data. There is no live OCI deployment from this development task.

Applying requires root on a Linux systemd host, Git and the runtime dependencies already provisioned. The installer does not install OS packages, Node, PostgreSQL, Docker, CloudPanel or firewall rules.

For Instance: provide Node 24 accessible to the unprivileged service account (not inside a private home directory), npm, runuser/useradd, pg_dump, an existing private test PostgreSQL database/runtime account and readable source TLS key/cert/CA files. The installer creates a root-path-specific `pactaris-instance-<hash>` user, builds unprivileged and copies the initial TLS material into protected component storage. It places the worker heartbeat in the component data directory. Configure the private firewall/proxy separately. Runtime DB permission must be restricted; no tenant schema/RLS migrations exist in this checkpoint.

For Identity: provide Docker Compose v2. The installer creates protected random secrets and starts a stable-project authentik/PostgreSQL stack with persistent named volumes and no published database/Docker socket. Authentik initial admin/brand/local enrollment/SMTP/OIDC clients/Google/Apple setup remains manual and unverified. Default provider TLS must be configured for a trusted backend identity before production proxy acceptance. The local container health check does not prove OIDC or external TLS works.

Only after reviewing those prerequisites, append `--apply` to the planned command. The installed tree has independent `config.json`, `releases/`, `current`, `data/`, `backups/`, operation lock and state per component. Do not put the source checkout or protected configuration under the service account's writable data directory.

## Updating and status

```bash
bash update.sh --component instance --root /opt/pactaris --revision "$REVISION" --check
bash status.sh --component instance --root /opt/pactaris
```

Update without `--apply` only prints a plan. A repeated install of an installed component refuses changes; use status/update. Apply preserves the stored configuration and ignores replacement config inputs by rejecting them. Read-only SSH deploy keys can be used with `--repository git@github.com:CoyWorks/Pactaris.git`; provision them out of band and never put tokens in URLs or arguments.

No migrations are supported yet: the deployer accepts only release manifests with protocol 1 and an empty migration list. The Instance DB is checkpointed with pg_dump before activation. Identity updates checkpoint PostgreSQL but reject changed provider/database image versions until a reviewed migration/restore runbook exists. Media-volume backup and off-host recovery still belong to #29 and are not claimed complete here. Source commits are operator-approved trust inputs; signed-release verification automation is still pending.

Application failure after an update switches back to the prior release and checks it when possible; this never claims a database rollback. A failed first install retains protected configuration/secrets and staged files for diagnosis. `resume.sh` can finish a staged first installation at the original exact SHA; see [RECOVERY.md](RECOVERY.md). It does not repair incomplete source clones, missing Identity secrets or interrupted updates. Do not delete provider volumes or overwrite secrets to retry. Component systemd unit templates are recreated when an Instance release is activated; review changes before approving the commit.

## Verification limits

Unit/HTTP-handler tests use synthetic fixtures and injected database probes. Real PostgreSQL policies, provider flows, TLS/proxy behavior, privileged service installation/reboot and a complete two-version host update are outstanding. The test environment may not allow listeners; handler injection avoids requiring a bound local port. CI is supplied but a remote successful run must be observed separately.

The i18n checker verifies English keys/message syntax, duplicate/orphan keys and a scoped set of visible JSX literals/attributes. This initial static check is not a comprehensive detector for every future server/template translation path.
