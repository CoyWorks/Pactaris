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
