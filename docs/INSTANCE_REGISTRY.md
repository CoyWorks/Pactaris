# Register the co-located pilot Instance

First implementation of #57/#58, not completion of remote fleet enrollment. This command trusts the operator's protected local Instance configuration as the identity attestation. TLS/readiness proves the endpoint is healthy and trusted, not a remote cryptographic Instance-ID challenge.

From 0.3.0 the normal all-component updater performs this registration idempotently for the known co-located shared-CA profile after runtime updates. The explicit commands below remain available for diagnosis/manual pilot enrollment. The updater does not overwrite conflicts, re-enable disabled entries or enroll a remote Instance merely from a hostname.

Requirements: installed gateway/Instance, migrations from 0.2.1-alpha.1 or later, root-owned canonical config paths, private literal bind addresses and the same internal CA. The gateway service's installed TLS CA copy is registered, because the gateway must be able to read it after the root command exits. Distinct-CA or split-host enrollment needs the later enrollment/trust workflow; do not broaden file permissions or disable verification.

Select the reviewed full revision and use the existing updater before registration. The gateway update applies the additive registry-event migration and takes its normal mandatory backup. The Instance update integrates the common permission check. Neither update changes the Identity deployment.

```bash
cd /opt/pactaris-source
git fetch origin main
# Set REVISION to the reviewed full commit supplied with this checkpoint.
git checkout --detach "$REVISION"
bash update.sh --component gateway --root /opt/pactaris --revision "$REVISION" --apply
bash status.sh --component gateway --root /opt/pactaris
bash update.sh --component instance --root /opt/pactaris --revision "$REVISION" --apply
bash status.sh --component instance --root /opt/pactaris
```

Run each command separately and stop on error. Run this plan as root; it reads protected files but makes no network requests or database changes:

```bash
flock -n /opt/pactaris/instance/operation.lock \
  flock -n /opt/pactaris/gateway/operation.lock \
  env APP_CONFIG=/opt/pactaris/gateway/config.json \
      INSTANCE_CONFIG=/opt/pactaris/instance/config.json \
  node /opt/pactaris/gateway/current/dist/server/scripts/register-instance.js
```

Apply by adding `--apply`:

```bash
flock -n /opt/pactaris/instance/operation.lock \
  flock -n /opt/pactaris/gateway/operation.lock \
  env APP_CONFIG=/opt/pactaris/gateway/config.json \
      INSTANCE_CONFIG=/opt/pactaris/instance/config.json \
  node /opt/pactaris/gateway/current/dist/server/scripts/register-instance.js --apply
```

Expected structured codes: `registry.plan`, then `registry.registered`; repeating apply returns `registry.unchanged` without another audit event. Errors return a generic `registry.failed` without credentials/endpoints. Diagnose protected config/file ownership, matching CAs, direct TLS readiness and migration state locally; do not paste credential-bearing config into issues/chat. The command refuses registry replacement and disabled-entry reactivation. It does not create a household, routing hint, enrollment secret or user permission.

For this pilot only, the operator uses the root-only non-superuser/non-BYPASS migration-role credential for the explicit allowlisted registry transaction. It never reaches the runtime/browser and the runtime retains SELECT-only registry privileges. A scoped management credential, Instance identity challenge, credential lifecycle and MFA-protected remote agent/API remain #57; do not expose this command as a web API or arbitrary shell execution.

## Technical permission foundation

`packages/auth/permissions.ts` is the common policy module. Only active local membership with a known technical role qualifies. The current summary route calls it after verifying the delegation and loading local membership.

| Action | Owner | Admin | Participant |
| --- | --- | --- | --- |
| View own household | Yes | Yes | Yes |
| Manage household settings/invitations | Yes | Yes | No |
| Leave; manage own consent; request own pause/household stop | Yes | Yes | Yes |
| Read someone else's private content by rank alone | No | No | No |
| Override another person's consent/pause | No | No | No |

Self permissions require future handlers to bind the target to the authenticated membership. They do not implement those mutations or bypass last-owner lifecycle handling. Resource visibility must come from trusted Instance queries/composite constraints, never request-supplied visibility/participant arrays. Current unexposed domain tables remain RLS-denied. This module does not replace PostgreSQL RLS, current consent/pause checks, versioned entitlements or API authorization.

## Read the gateway inventory

From the gateway host as root, run the inventory command in the active gateway release. It reports routing state from the central registry and the time that it was read. It returns a maximum of 50 rows per page.

```bash
cd /opt/pactaris/gateway/current
APP_CONFIG=/opt/pactaris/gateway/config.json node dist/server/scripts/instance-inventory.js
```

Use `--instance INSTANCE_UUID` to list registered household IDs for one Instance. If the result includes a `nextCursor`, pass it to `--after CURSOR` with the same filter. A registry entry remains visible when its Instance cannot be reached. Counts describe stored active and disabled placements. They do not reflect live database contents or worker health.

The output excludes backend addresses, credentials, member lists and household names. This command runs locally with the existing registry read grants. It performs no remote enrollment, relocation or registry write. A separate MFA-protected manager UI and live per-Instance reporting remain in #57 and #59.

The operator console at `/operator` can also display this inventory. It requires the same recent MFA and operator allowlist as the SMTP panel. The UI and API return registered placement counts and household IDs, not private routing endpoints or credentials. The observed timestamp is the registry read time. Health telemetry and remote enrollment remain separate.
