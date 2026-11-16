# Resume an interrupted first installation

Use this only when a first installation was interrupted after checkout, before a successful `state.json` was recorded. It is not update recovery or a replacement for a database restore. Preserve all existing configuration, secrets, volumes, certificates and instance IDs.

## What changed

The installer previously captured child output silently. Long authentik initialization and npm installation could therefore look stuck. It now prints a keyed command-start message and a waiting message every 15 seconds without publishing command arguments or child output. Errors identify the executable and exit code; credentials remain private. Identity startup allows 540 seconds, within the existing ten-minute subprocess deadline. Ctrl+C terminates the active command group and reports a controlled interruption; already started Docker containers remain in place.

Status distinguishes staged/incomplete installations from absent installations. `resume.sh` uses the original staged source revision and existing component configuration. It refuses completed installations, missing Identity secrets, a different active release and changed tracked source files. It keeps the Compose project name and volumes. It does not clone a new release, regenerate Identity secrets or change stored configuration. Instance dependency installation/build is repeated as the component user; certificates are copied only if no component configuration has yet been stored. State is written only after the normal health gates succeed.

## Before resuming

Check container state and recent logs. Initial provider migrations can take several minutes; warnings during that interval do not alone prove a persistent failure. An HTTP 200 from the npm registry proves endpoint access from that shell, not that all dependency downloads/builds have completed. The installer remains experimental; real host recovery must still be validated.

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
