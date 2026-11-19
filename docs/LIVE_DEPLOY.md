# Live deployment from GitHub

The single alpha host, `srv-oci-web01`, runs Gateway, Instance and Identity. The deployment service polls `main` in `CoyWorks/Pactaris`. With the timer enabled in apply mode, the current `main` head deploys automatically once its CI run passes. Repository write access to `main` therefore controls what reaches the host.

The service pins the current `main` SHA, checks the latest matching push run of `.github/workflows/ci.yml` on `main` for success, and checks the branch head again before proceeding. A newer head waits for its own successful run. It then calls the existing updater with all three installed components and the exact SHA. The updater still controls component ordering, backups, migrations, health and Identity image changes. Identity retains its existing revision if its Compose definition is unchanged. The service checks the Gateway and Instance revisions after an apply and records all three installed revisions in the local journal. No additional inbound port or GitHub Actions runner is needed.

## One-time setup

1. Create a credential scoped to **CoyWorks/Pactaris** with **Actions read**, **Contents read** and **Commit statuses write**. Install its value as root at `/etc/pactaris/deploy-live.github-token` (mode `0600`). This is separate from any Git source credential already used by the updater. Keep both credentials on the host. Commit statuses in this public repository must contain only generic outcomes.
2. On `srv-oci-web01`, install the files from the reviewed revision containing this runbook. With the existing source checkout and the full reviewed commit in `REVISION`:

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

3. With the current `main` head CI-green, run `sudo systemctl start pactaris-live-deploy.service` once. The default mode is `plan`, which uses `update.sh --check`. Confirm GitHub status `pactaris/live-preflight` is green and the journal shows unchanged revisions:

   ```bash
   sudo journalctl -u pactaris-live-deploy.service -n 50 --no-pager
   ```

4. After the preflight succeeds, enable live mode and its timer. The first apply selects the current CI-green `main` head at runtime, which can be newer than the preflight SHA:

   ```bash
   printf '%s\n' 'PACTARIS_DEPLOY_MODE=apply' | sudo tee /etc/pactaris/deploy-live.env >/dev/null
   sudo systemctl enable --now pactaris-live-deploy.timer
   sudo systemctl start pactaris-live-deploy.service
   ```

The service assumes the existing root at `/opt/pactaris` and updater at `/opt/pactaris-source/update.sh`. If the host uses a private source via a dedicated SSH origin, configure the service's command to pass the reviewed `--repository` value. The first real run must be observed. The normal updater can restart the affected services during an alpha deploy.

## Status and recovery

Use the SHA's GitHub commit status **pactaris/live** to distinguish pending, success and failure. The service retries publishing an already recorded result when GitHub status reporting fails. It does not repeat a completed apply. On a failed or interrupted update, automatic deployments pause, including requests for a different SHA. Earlier components may already have activated and migrations may have run. Review the journal and actual installed revisions first, and follow [recovery](RECOVERY.md) if needed.

Once the issue is resolved, stop the timer, ensure the service has finished, move `/var/lib/pactaris-live-deploy/state.json` to a root-only incident archive and start the timer. Check the current `main` SHA before resuming. Stopping the timer alone leaves an already running updater in progress.
