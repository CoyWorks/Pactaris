# Live deployment from GitHub

The single alpha host, `srv-oci-web01`, runs Gateway, Instance and Identity. The deployment service polls `deploy/live` in `CoyWorks/Pactaris`. A release is a deliberate branch update to an exact SHA. Moving `main` alone has no effect on the host.

The service verifies that the requested SHA belongs to `main` and that the latest matching push run of `.github/workflows/ci.yml` on `main` completed successfully. It then calls the existing updater with all three installed components and the exact SHA. The updater still controls component ordering, backups, migrations, health and Identity image changes. Identity retains its existing revision if its Compose definition is unchanged. The service checks the Gateway and Instance revisions after an apply and records all three installed revisions in the local journal. No additional inbound port or GitHub Actions runner is needed.

## One-time setup

1. In GitHub, create a ruleset for `deploy/live` that restricts creation and updates to the trusted release actor, and blocks force pushes and deletion. Check the ruleset when granting the release actor access. Protect `main` with the normal review and CI rules. Keep the `pactaris/live` and `pactaris/live-preflight` status contexts out of the required source checks.
2. Create a credential scoped to **CoyWorks/Pactaris** with **Actions read**, **Contents read** and **Commit statuses write**. Install its value as root at `/etc/pactaris/deploy-live.github-token` (mode `0600`). This is separate from any Git source credential already used by the updater. Keep both credentials on the host. Commit statuses in this public repository must contain only generic outcomes.
3. On `srv-oci-web01`, install the files from the reviewed revision containing this runbook. With the existing source checkout and the full reviewed commit in `REVISION`:

   ```bash
   cd /opt/pactaris-source
   sudo git fetch origin "$REVISION"
   sudo bash -c '
     set -euo pipefail
     stage="$(mktemp -d)"
     trap '\''rm -rf -- "$stage"'\'' EXIT
     git archive "$1" scripts/live_deploy.py scripts/install_live_deploy.sh deploy/systemd | tar -x -C "$stage"
     bash "$stage/scripts/install_live_deploy.sh"
   ' pactaris-live-install "$REVISION"
   ```

4. With the branch set to a CI-green SHA, run `sudo systemctl start pactaris-live-deploy.service` once. The default mode is `plan`, which uses `update.sh --check`. Confirm GitHub status `pactaris/live-preflight` is green and the journal shows unchanged revisions:

   ```bash
   sudo journalctl -u pactaris-live-deploy.service -n 50 --no-pager
   ```

5. With the reviewed first deployment still selected on the protected branch, enable live mode and its timer:

   ```bash
   printf '%s\n' 'PACTARIS_DEPLOY_MODE=apply' | sudo tee /etc/pactaris/deploy-live.env >/dev/null
   sudo systemctl enable --now pactaris-live-deploy.timer
   sudo systemctl start pactaris-live-deploy.service
   ```

The service assumes the existing root at `/opt/pactaris` and updater at `/opt/pactaris-source/update.sh`. If the host uses a private source via a dedicated SSH origin, configure the service's command to pass the reviewed `--repository` value. The first real run must be observed. The normal updater can restart the affected services during an alpha deploy.

## Status and recovery

Use the SHA's GitHub commit status **pactaris/live** to distinguish pending, success and failure. The service retries publishing an already recorded result when GitHub status reporting fails. It does not repeat a completed apply. On a failed or interrupted update, automatic deployments pause, including requests for a different SHA. Earlier components may already have activated and migrations may have run. Review the journal and actual installed revisions first, and follow [recovery](RECOVERY.md) if needed.

Once the issue is resolved, stop the timer, ensure the service has finished, move `/var/lib/pactaris-live-deploy/state.json` to a root-only incident archive and start the timer. Check the branch SHA before resuming. Stopping the timer alone leaves an already running updater in progress.
