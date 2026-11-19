# Public ingress smoke checks

Run from a client outside the deployment network after a Pactaris update or CloudPanel change. Pass the exact public gateway origin and the configured issuer, including its trailing slash when present.

```bash
python3 scripts/public_smoke.py \
  --app-origin https://pactaris.app \
  --issuer 'https://identity.pactaris.app/application/o/pactaris/'
```

The check uses HTTPS with normal certificate verification. It checks the public app entry and its cache/security headers, gateway readiness, the logged-out session response and cache policy, the PWA manifest and worker, and the configured issuer and endpoint origins in OIDC discovery. It follows neither redirects nor discovery endpoints. It sends no cookies, sign-in requests or mutations.

The command prints one JSON report and returns a nonzero exit status when a check fails. Use the public report together with [local monitoring](OPERATIONS_MONITORING.md) to distinguish public routing from backend readiness. Sign-in, registration, household boundaries, load and real mobile acceptance remain separate release gates in #31.

## Operator access

Before inviting alpha users, check that a regular signed-in account sees no SMTP or instance details on the operator APIs. Sign in with the configured operator account and complete the Identity MFA flow. Open the instance registry and the SMTP status page. Repeat after the five-minute proof expires and after logging out. An expired proof must require a fresh MFA sign-in, and a signed-out browser must lose access. The automated suite verifies the Gateway endpoint boundary, signed MFA evidence and database session lookup with fixtures. The hosted Identity flow still needs this separate check.

## CloudPanel host acceptance

| Check | Evidence to record |
| --- | --- |
| Public app and Identity | Run the public smoke from outside the deployment network. Record the revision, time and each check result. |
| Internal TLS | Run the local component status checks and compare the rendered NGINX SNI, TLS verification and trust bundle with the installed listener configuration. Use the certificate-verifying direct request from [first installation notes](FIRST_INSTALL_NOTES.md) for Identity. |
| Logs | Send the synthetic query in [proxy logging](CLOUDPANEL_ACCESS_LOGS.md). Record the request class and status with the query absent. |
| Independent updates | Use the [updater preflight](INSTALL_UPDATE.md) for each selected component. During a scheduled update, record revisions and readiness before and after for all installed components. |
| Reboot | After an authorized reboot, run public smoke and local status checks again. Verify a test account can open its expected household. |

Preflight and fixture output provide separate evidence from a live update or reboot. Keep raw vhost configuration, cookies and authentication artifacts out of the acceptance log.
