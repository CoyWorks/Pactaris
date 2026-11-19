# Resume an interrupted first installation

Use this only when a first installation was interrupted after checkout, before a successful `state.json` was recorded. It is not update recovery or a replacement for a database restore. Preserve all existing configuration, secrets, volumes, certificates and instance IDs.

## What changed

The installer previously captured child output silently. Long authentik initialization and npm installation could therefore look stuck. It now prints a keyed command-start message and a waiting message every 15 seconds without publishing command arguments or child output. Errors identify the executable and exit code; credentials remain private. Identity startup allows 540 seconds, within the existing ten-minute subprocess deadline. Ctrl+C terminates the active command group and reports a controlled interruption; already started Docker containers remain in place.

Status distinguishes staged/incomplete installations from absent installations. `resume.sh` uses the original staged source revision and existing component configuration. It refuses completed installations, missing Identity secrets, a different active release and changed tracked source files. It keeps the Compose project name and volumes. It does not clone a new release, regenerate Identity secrets or change stored configuration. Instance dependency installation/build is repeated as the component user; certificates are copied only if no component configuration has yet been stored. State is written only after the normal health gates succeed.

Deployment ancestor directories explicitly allow traversal even when the invoking shell uses `umask 077`. Built Instance releases remain root-owned and readable/executable by the service group, with no access for other users. TLS directories explicitly allow service-group traversal while keys remain restricted.

## Before resuming

Check container state and recent logs. Initial provider migrations can take several minutes; warnings during that interval do not alone prove a persistent failure. An HTTP 200 from the npm registry proves endpoint access from that shell, not that all dependency downloads/builds have completed. The installer remains experimental. The first co-located recovery was later confirmed by operator output; see [FIRST_INSTALL_NOTES.md](FIRST_INSTALL_NOTES.md). Wider clean/split-host recovery acceptance remains pending.

If an older installer was interrupted, obtain the reviewed resume-capable tooling in the separate source checkout. Keep the release SHA passed to resume equal to the interrupted installation's SHA, not the new tooling commit. Review any local checkout changes before switching source revisions.

## Example: initial 2026-11-16 deployment

Original staged release:

```bash
REVISION="ed86e4261d3e551b5dee03aabc17d74042d9cc09"
cd /opt/pactaris-source
```

After selecting the reviewed resume-capable tooling commit in this source checkout, plan both components:

```bash
bash resume.sh --component identity --root /opt/pactaris --revision "$REVISION"
bash resume.sh --component instance --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/instance.json --revision "$REVISION"
```

Identity uses its existing `/opt/pactaris/identity/config.json` and `identity.env`. Instance uses its stored config if present, otherwise the original bootstrap file. Do not create a new database, UUID or certificates.

Apply one component at a time and stop if a command fails:

```bash
bash resume.sh --component identity --root /opt/pactaris --revision "$REVISION" --apply
bash status.sh --component identity --root /opt/pactaris
```

Then:

```bash
bash resume.sh --component instance --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/instance.json --revision "$REVISION" --apply
bash status.sh --component instance --root /opt/pactaris
curl --cacert /etc/pactaris/bootstrap/ca.crt \
  --resolve instance1.coyworks.nl:9444:127.0.0.1 \
  https://instance1.coyworks.nl:9444/health/ready
```

Both component statuses must report `ready: true`, and Instance readiness must return HTTP 200. These are local foundation checks, not proof of working OIDC or public proxy configuration. On an npm failure, root can inspect the protected component cache logs under `/opt/pactaris/instance/data/npm-cache/_logs/`; review them for secrets before sharing.

## Limits

Resume does not repair a half-cloned Git checkout, Identity configuration written without its original secrets, incomplete JSON temporary writes, damaged TLS files, a failed migration or an interrupted update. Refuse and diagnose those cases rather than deleting data or synthesizing success state. Retrying a health failure must preserve the original revision and configuration. Partial installations from historical deployment naming require a separate reviewed migration.

## Instance checkpoint fails at pg_dump

The original checkpoint code put the entire configured PostgreSQL URL in `PGDATABASE`. A native libpq reproduction confirmed that an environment-supplied database URL is treated as a literal database name rather than expanding its embedded user/host/password. This could select the invoking OS user/default connection instead of the configured account. The corrected checkpoint explicitly supplies host, port, database and user; the password is in a temporary mode-0600 `PGPASSFILE` inside the private backup directory, removed on success or failure. Passwords are not added to command arguments or `PGPASSWORD`. Supported URI query options are mapped to their libpq environment variables; unsupported options fail rather than being silently discarded.

A failed dump remains `database.sql.partial`; only a successful command promotes it to `database.sql`. On a nonzero pg_dump exit, the installer prints the path to a private `pg_dump.stderr.log` in that checkpoint directory. Root can inspect this file locally to distinguish connection, authentication, permission and version errors. Review it before sharing. The backup gate is mandatory and no activation/success state is synthesized after failure.

Obtain the reviewed fixed tooling commit, then resume **Instance only** at its original staged SHA with the existing configuration. A successfully completed Identity installation does not need to be resumed again. Existing failed checkpoint directories are retained for diagnosis.

References: [libpq environment variables](https://www.postgresql.org/docs/current/libpq-envars.html), [password files](https://www.postgresql.org/docs/current/libpq-pgpass.html).

Verification includes a native libpq parameter-parsing reproduction, synthetic tests for decoded URI values, explicit connection fields, private/temporary password files, failing dumps remaining partial, preservation of TLS options, rejection of unsupported query options and private stderr diagnostics. This is not a live PostgreSQL backup/restore integration test; the first successful Instance checkpoint/resume on the target host was later confirmed by operator output in [FIRST_INSTALL_NOTES.md](FIRST_INSTALL_NOTES.md). Full restore and broader deployment acceptance remain pending.

## npm install/build diagnostics — 17 November 2026

A reported gateway update failed in `npm run build` at application revision `6677e6f75eda31839f422d6ee7119efbbc699e65`, using Node 24.22.3/npm 11.19.1. npm's cache debug log confirmed exit 1 but did not contain the compiler/bundler output. The underlying server build failure is not diagnosed by that evidence; do not assume a Node version, memory, dependency or database cause.

New deployer tooling writes combined stdout/stderr directly into root-only logs for each npm command. Logs live outside the service-owned release/cache at `/opt/pactaris/<component>/build-logs/<attempt>-<revision>/npm-ci.log` and `npm-build.log` (directories 0700, files 0600, exclusive creation). Progress still hides arguments/output. Failure, timeout or interruption reports the protected log path; normal cancellation still terminates the child group. Logs remain for operator diagnosis, including successful earlier build steps, and are not automatically deleted. Review locally for credentials before sharing a relevant error block.

The one-command updater fetches fresh tooling automatically. For this reported failure, retry only the already installed gateway with `bash /opt/pactaris-source/update.sh --component gateway`. This preserves its configuration/secrets, retains the previous active gateway on a build failure, archives inactive failed staging on retry and runs the same build/backup/migration/activation/health gates. It does not reinstall Identity or reset data. After a failure, root can inspect the exact emitted `cli.commandLog` path with `tail -n 100 -- /path/from/message`. Diagnosis capture is not a fix for an unknown compiler/bundler failure, nor proof of live-server recovery.

## Confirmed compiler stack failure and repair — 17 November 2026

The protected gateway log subsequently showed `RangeError: Maximum call stack size exceeded` in TypeScript 5.9.3's expression checker, before Vite ran. The application build was compiling `tests/postgres.integration.ts` along with production sources. That single growing async test caused the same compiler failure locally on Node 24 with a 512 KiB V8 stack; excluding that fixture removed the failure.

Production compilation now uses `tsconfig.build.json`, which includes apps/packages/scripts and excludes tests. The normal all-source typecheck still checks every test. Four existing isolated scenario blocks (consent/safety, workspace, library and routines) now execute as separately checked awaited async functions, preserving their order/assertions/transactions and shared teardown. The complete typecheck passes at the same 512 KiB stack limit that reproduced the old failure. CI enforces this limit, checks that the fresh production artifact contains no tests and still executes the real PostgreSQL/HTTPS integration fixture. This is a compiler/build-scope repair; it changes no application authorization, migrations or runtime data.

Retry the installed gateway with the normal preserving updater, then verify status and the public login/logout flow. Host recovery remains unconfirmed until the operator observes the new build and activation. Protected diagnostic logs remain available if a different build problem is exposed.


## On-demand database checkpoint

From a reviewed checkout, preview a checkpoint for an installed component. Repeat with `--apply` as root to run the dump without a deployment or service restart.

```bash
bash /opt/pactaris-source/backup.sh --component identity
bash /opt/pactaris-source/backup.sh --component identity --apply
```

Use `gateway` or `instance` for those components. Pass `--root` for a nondefault installation root. The same per-component lock serializes checkpoints and updates. The command reports the resulting private directory. A successful SQL dump and metadata are published as `database.sql` and `backup.completed.json`. A failed dump stays partial. On Identity this also prevents a truncated dump from being mistaken for a usable checkpoint. Keep checkpoint copies of configuration and credentials private.

These local checkpoints cover the database and deployment configuration snapshot. Retain referenced secret files, Identity media and Instance file storage independently. Encrypted off-host copies, restore and reconciliation drills, and retention and recovery targets are tracked in #29. A checkpoint on the original VM alone cannot protect against loss of that VM.

## Encrypted copies and isolated restore drills

Install the age CLI on the backup host. Generate the recipient and the private identity on the recovery host. Keep the private identity offline or in the approved recovery secret store. Only the public recipient is required on the source host.

After `backup.sh --apply` reports a completed checkpoint, encrypt it into an operator-controlled directory. Use a unique filename per checkpoint.

```bash
python3 scripts/encrypt_checkpoint.py \
  --checkpoint "$CHECKPOINT_DIRECTORY" \
  --output "$BACKUP_DIRECTORY/gateway-2026-11-19.tar.age" \
  --recipient "$AGE_PUBLIC_RECIPIENT"
```

Transfer the encrypted file to the approved off-host store, or use a protected mounted destination there. The script writes an encrypted temporary file and publishes it after successful encryption. The existing SQL snapshot stays protected on the source host. Back up referenced secret files, media and Instance file data through separate protected copies. Track verification, retention and key recovery as part of the operational backup schedule.

For a restore drill, retrieve a checkpoint from the off-host store and decrypt it on the isolated recovery host. List the archive before extracting. Use a new root-only directory and verify the expected database checkpoint metadata. Restore only into a disposable empty PostgreSQL target with a compatible version and the needed roles. Keep restored app processes offline, with no SMTP, push, live placement publishing or production traffic.

Record the checkpoint age and observed recovery time. Inspect the restored schemas and compare household membership and placement checks against the recorded pre-loss state. In a synthetic dataset, revoke access and delete a record after the checkpoint, then confirm that opening the backup does not reintroduce either into service. Keep traffic disabled until a trusted current revocation/deletion history has been reconciled. The existing checkpoint alone cannot prove that history is complete. The gateway's copy of the [revocation journal](REVOCATION_JOURNAL.md) records that history for each Instance. Instance checkpoints restore fenced: the restored Instance serves no household data and runs no jobs until the gateway has replayed that copy and released the fence. Confirm the `journal.restore_released` gateway log line before declaring an Instance restore complete.

[age CLI reference](https://github.com/FiloSottile/age/blob/main/doc/age.1.html)
