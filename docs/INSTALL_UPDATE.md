# First-slice install and update contract

Status: the one-command updater below is implemented; the minimal-input fresh installer is still planned. See [INSTALLER_EXPERIENCE.md](INSTALLER_EXPERIENCE.md) for the broader requirements. Issue #56 is M0; advanced fleet rollout stays #59. Start with empty production databases and no legacy accounts/content.

## Update an installed server

After the one-time bootstrap to an updater-capable checkout, run as root:

```bash
bash /opt/pactaris-source/update.sh
```

This fetches the current `main`, resolves it once to a full commit SHA, and runs the freshly fetched updater/deployer. It does not reset, overwrite or require a clean operator source checkout. Every component in this invocation uses that one selected SHA even if main moves while updating. Main is the owner-authorized source channel; this does not imply the selected commit passed CI or is a signed release. A full reviewed SHA can be pinned with `--revision`.

Installed components are discovered from their separate completion state under `/opt/pactaris`: gateway, Instance, then Identity. It never installs absent components or tries to finish a staged first installation. An incomplete install is an explicit blocker, not something silently ignored.

Each changed component retains the existing build, backup, migration, activation/recovery and health gates. No configuration, IdP account, key, database, file or hostname is replaced by an example. Unchanged application revisions receive health checks without rebuilding. Identity is not restarted or relabeled when its Compose deployment is identical; changed pinned provider images block automatic updates before any component activation and require a provider-specific runbook.

The parent process holds a server-wide updater lock throughout source fetch/handoff and all component operations; each deployer retains its own component lock. A failed step stops later updates. This is not a distributed atomic upgrade: earlier successful components remain active. An interrupted child receives cancellation and is stopped before temporary tooling is removed.

A subsequent retry preserves an inactive failed staged application release under the component's private `failed-releases/` directory, then rebuilds the same pinned revision cleanly. It refuses to move active releases, symlinks or anything referenced by installed state/current. Config/data/backup directories are not reset. Already applied additive migrations are checked by immutable checksum and not undone. This is a bounded retry facility, not general database restore or recovery from an incompatible schema change.

Other supported forms:

```bash
# Fetch and inspect the plan, without updating services/application data.
bash /opt/pactaris-source/update.sh --check

# Update only one independently installed component.
bash /opt/pactaris-source/update.sh --component instance

# Use an alternate existing deployment root.
bash /opt/pactaris-source/update.sh --root /srv/pactaris

# Pin all selected updates to a reviewed full commit.
bash /opt/pactaris-source/update.sh --revision "$REVISION"
```

Applying is now the default for update.sh; use `--check` or `--plan` for planning. `--apply` remains accepted for previous commands. This changes the historical update wrapper's plan-only default; install.sh/resume.sh keep their explicit `--apply` requirement. `--check` still downloads temporary source and obtains a local lock, but does not build, migrate, activate or restart services. It is a preflight/plan, not proof a future build/health check will succeed. Pinned targets must contain this updater contract; historical releases predating scripts/update.py need their component-specific deployment/recovery runbook instead.

The updater uses the host's existing Git read access (credential helper or scoped deploy key); no tokens in command-line URLs. An SSH source URL can be supplied with `--repository git@github.com:CoyWorks/Pactaris.git`; the same URL is passed to each component source fetch. No GitHub write permission is needed. Private-source acceptance remains to be rehearsed before changing repository visibility.

The command assumes an already prepared 0.2 deployment with separate migration/backup credentials. It does not silently bootstrap an older 0.1 database, change domains, enroll remote servers, apply IdP branding or modify CloudPanel. From 0.3.0, a default all-component update also idempotently registers the known co-located shared-CA Instance after successful runtime health checks. Different-CA and component-only updates preserve independent enrollment. See LOGIN_ROLLOUT.md for the original preparatory migration and INSTANCE_REGISTRY.md for pilot registry setup.

## One-time updater bootstrap

For a checkout whose update.sh still requires component/root/revision, obtain a reviewed updater-capable revision once:

```bash
cd /opt/pactaris-source
git fetch origin main
git checkout --detach origin/main
bash update.sh
```

Git checkout refuses conflicting tracked edits; do not use reset --hard or discard local changes to bypass it. Future calls need only the single update command above. A source fetch/permission failure exits before runtime changes and retains all installed data.

## Entry points

| Planned script | Responsibility |
| --- | --- |
| install.sh | Preflight and idempotent central/internal profile installation |
| update.sh | Fetch/stage/check a pinned GitHub version, migrate, activate, verify and recover |
| status.sh | Installed version/commit, service/readiness/worker status and last update outcome |

Use the Gateway's active release to run the newest installed status command against each component:

```bash
for component in gateway instance identity; do
  sudo bash /opt/pactaris/gateway/current/status.sh --component "$component" --root /opt/pactaris
done
```

The status record includes the component's installed `version`, `revision` and current `ready` result. A legacy state without a recorded version returns `null` for `version`. An unchanged Identity deployment can retain its previous revision after an application update.

Keep commands small and operationally familiar; detailed implementation may use shared internal helpers. CLI prose uses #44 catalogs, secrets never appear in output.

## Independent installable components

Each component has its own artifact, service identities, config/secrets, data/migrations, lock, active release and status. The default updater orchestrates installed components; `--component` retains independent updates. An optional install-both convenience profile is still planned. Installing an Instance does not install local Identity or CloudPanel; installing Identity does not create a tenant Instance. A selected single-component update never restarts/migrates another component.

Default app HTTPS ingress: Identity 9443, Instance 9444. All ports/bind interfaces and public origins are validated configuration. On separate hosts instances reuse 9444; multiple local instances need distinct endpoints. CloudPanel admin remains on its existing 8443.

## Hosting profiles

Central is an optional co-location arrangement: integrate the existing CloudPanel ingress with independent Identity, manager and main-instance services/data boundaries. Internal: own Node API/worker, PostgreSQL, private files, TLS identity and systemd units; no CloudPanel installation required. Accept actual domains/private bind addresses/proxy source addresses as inputs. Do not overwrite unrelated sites or expose database ports.

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

An operator can register an instance; a fresh synthetic user deployment can log in at the canonical public origin, select an authorized household without seeing instance names, create/join a dynamic, accept scoped consent, complete a task, stop and export/leave. Demonstrate initial install, repeat installer run, restart/reboot recovery and update to a second pinned GitHub version preserving data. Exercise failed update and private-source-access failure before claiming the tool complete.

Full production backup/security gates remain #28/#29/#31. Manager automation later uses the same allowlisted pinned update contract (#59), rather than adding arbitrary remote commands.

## Split deployment acceptance

Install Identity on one host, Instance on another and a separate proxy in front. Configure public identity/instance origins, external issuer/client/callback, private bind endpoint and backend TLS identity independently. Verify private DNS avoids public-proxy recursion, correct cert verification for loopback/remote targets and host-scoped sessions. Run an Identity-only update and Instance-only update without restarting or altering the other application. Check compatible protocol versions and data preservation. See docs/INFRASTRUCTURE.md for the example proxy map.

For the single alpha host's GitHub-triggered update service, see [Live deployment](LIVE_DEPLOY.md).
