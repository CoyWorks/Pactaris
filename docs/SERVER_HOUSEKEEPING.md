# Server housekeeping

Owner decision, 21 November 2026. `scripts/housekeeping.py` keeps the host from filling up with old checkpoints, releases, logs and caches. It runs daily from a systemd timer (around 04:17, after the off-host backup) and handles each installed component under `/opt/pactaris` under that component's operation lock: while an install, update or backup runs, the component is skipped and retried the next day.

| What | Kept | Removed |
| --- | --- | --- |
| Local database checkpoints (`<component>/backups/<19 digits>`) | The newest 7, plus the newest of each of the last 4 ISO weeks and of the last 3 months; the newest completed checkpoint always | Older completed checkpoints, and incomplete ones older than 2 days |
| Release directories (`<component>/releases/<revision>`) | The one `current` points to, the one in `state.json`, and 1 more (for rollback) | Older revisions. Nothing is removed when `state.json` cannot be read |
| `failed-releases/` | The newest 3 | Older entries |
| `build-logs/` | The newest 10 | Older entries |
| `data/npm-cache` | — | The whole cache when larger than 1 GiB (the next build recreates it) |
| Container images (Identity hosts) | Every tagged image and every image a container uses | Dangling images (`docker image prune -f`) |
| System journal | At most 1 GiB and 30 days | Older entries (`journalctl --vacuum-…`), plus a permanent journald limit |

Off-host archives are pruned by the off-host backup itself (`keep`, see [RECOVERY.md](RECOVERY.md#scheduled-off-host-backups)). Symlinks are never followed or removed. Output is one JSON line per action, without file contents or secrets; `/var/lib/pactaris-housekeeping/state.json` records the last run.

## Install

```bash
bash /opt/pactaris-source/scripts/install_housekeeping.sh
python3 /usr/local/lib/pactaris/housekeeping.py --dry-run
systemctl enable --now pactaris-housekeeping.timer
```

The installer copies the script and units and adds a journald limit (`/etc/systemd/journald.conf.d/pactaris.conf`); it does not enable the timer. Review the dry run first.

Optional `/etc/pactaris/housekeeping.json` (root, 0600) changes the defaults within safe bounds:

```json
{"daily": 7, "weekly": 4, "monthly": 3, "incompleteDays": 2, "releases": 1, "failedReleases": 3,
 "buildLogs": 10, "npmCacheMegabytes": 1024, "journalMegabytes": 1024, "journalDays": 30, "images": true}
```

Unknown keys or values out of range stop the run with `housekeeping.config`.
