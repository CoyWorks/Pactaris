# Local operations monitoring

Run one check per installed component from a host monitor under an operator account with the required local config, systemd and Docker access.

```bash
python3 /opt/pactaris-source/scripts/monitor.py --component gateway
python3 /opt/pactaris-source/scripts/monitor.py --component instance
python3 /opt/pactaris-source/scripts/monitor.py --component identity
```

Use `--root` for a custom installation root. The command emits one JSON object. Exit zero means the existing readiness checks passed. Exit one means a readiness or collection failure. Node components use the verified backend HTTPS request, systemd checks and the worker heartbeat. Identity uses its existing container healthcheck. Monitor public HTTPS separately to verify CloudPanel routing.

| Field | Meaning |
| --- | --- |
| `ready` | Result of the component readiness check |
| `probeDurationMs` | Time spent checking local readiness |
| `workerHeartbeatAgeSeconds` | Time since the Node worker published its last heartbeat, or null for Identity or an unavailable heartbeat |
| `databaseCheckpointAgeSeconds` | Time since the latest marked local checkpoint with a matching SQL dump size, or null if none is known |
| `installationDiskFreeBytes` | Free bytes on the installation filesystem |

The report contains no database URLs, credentials, account identifiers, household content, invite links or private paths. Treat the local monitoring account as an operator credential. Keep collected status data within the operator monitoring system.

Alert after successive readiness failures so a brief service restart during an update does not page immediately. Alert separately on backup age using the operator's checkpoint cadence and on free space based on the observed growth of deployment backups. If readiness fails, compare the public URL with the local result, then check the affected component's service and worker status. If checkpoint age rises, inspect its protected dump diagnostics and confirm that the backup job actually runs. A local database checkpoint does not verify off-host recovery.

Queue and delivery failure metrics, external alert configuration and off-host backup freshness remain follow-up in #29/#30.

The Gateway worker publishes aggregate invitation delivery counts when a mail relay is configured. The local monitor includes queued and currently due jobs, failed jobs within the queue's retention window, and the age in seconds of the oldest due job. An empty due queue has a null age. A missing or unreadable worker sample likewise has a null queue report. Check the worker heartbeat age before acting on queue figures. Sample collection leaves job payloads, addresses, and relay credentials out of monitor output.
