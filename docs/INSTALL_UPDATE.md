# First-slice install and update contract

Status: required implementation scope, not available scripts. Issue #56 is M0; advanced fleet rollout stays #59. Start with empty production databases and no legacy accounts/content.

## Entry points

| Planned script | Responsibility |
| --- | --- |
| install.sh | Preflight and idempotent central/internal profile installation |
| update.sh | Fetch/stage/check a pinned GitHub version, migrate, activate, verify and recover |
| status.sh | Installed version/commit, service/readiness/worker status and last update outcome |

Keep commands small and operationally familiar; detailed implementation may use shared internal helpers. CLI prose uses #44 catalogs, secrets never appear in output.

## Hosting profiles

Central: integrate with the existing CloudPanel public ingress and separate identity, manager and main-instance services/databases. Internal: own Node API/worker, PostgreSQL, private files, TLS identity and systemd units; no CloudPanel installation required. Accept actual domains/private bind addresses/proxy source addresses as inputs. Do not overwrite unrelated sites or expose database ports.

Initial identity methods: Google, Apple and locally registered verified email/password accounts through one maintained central identity service; instances use central OIDC. Provider credentials are provisioned separately from GitHub code. Domain/Apple Services ID/App ID/keys and Google OAuth setup must be verified before declaring all login flows operational.

## Source access

The same updater must work while the GitHub repository is public and after it becomes private. Provision a repository-scoped read-only deploy key or equivalent least-privilege credential per instance; no shared repository-write PAT or credentials embedded in URLs, shell arguments, committed config or logs. Keep identity secrets, runtime secrets and source-access keys separate.

Fetch an operator-approved tag/version resolved to an exact commit or verified release artifact. Record provenance and installed commit. Verify source/artifact authenticity through the documented trusted release policy; a checksum obtained from an untrusted source is not sufficient authentication. No blind curl-to-root execution or destructive pull/reset over live data/configuration.

## Update transaction

1. Acquire a per-instance update lock; check compatibility, disk, credentials and source reachability.
2. Fetch/stage the approved release in a separate versioned directory.
3. Install locked dependencies, build/check artifacts and validate preserved configuration.
4. Take required database/file/config recovery checkpoints and coordinate maintenance/jobs.
5. Apply reviewed migrations with separate credentials. Record any irreversible step.
6. Activate the release, restart systemd services and verify API/readiness plus worker recovery through the proxy.
7. Keep logs/result/version metadata without secrets and release the lock.

Failure must preserve the prior healthy application when schema compatibility permits. Code rollback does not undo an incompatible database migration; use an explicit tested restore procedure and reconcile deletion/identity/placement state. Never overwrite .env, instance identity, uploaded files or database with repository defaults.

## First working version acceptance

A fresh synthetic deployment can log in, register/select an instance, create/join a dynamic, accept scoped consent, complete a task, stop and export/leave. Demonstrate initial install, repeat installer run, restart/reboot recovery and update to a second pinned GitHub version preserving data. Exercise failed update and private-source-access failure before claiming the tool complete.

Full production backup/security gates remain #28/#29/#31. Manager automation later uses the same allowlisted pinned update contract (#59), rather than adding arbitrary remote commands.
