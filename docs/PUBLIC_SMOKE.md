# Public ingress smoke checks

Run from a client outside the deployment network after a Pactaris update or CloudPanel change. Pass the exact public gateway origin and the configured issuer, including its trailing slash when present.

```bash
python3 scripts/public_smoke.py \
  --app-origin https://pactaris.app \
  --issuer 'https://identity.pactaris.app/application/o/pactaris/'
```

The check uses HTTPS with normal certificate verification. It checks gateway readiness, the logged-out session response and cache policy, the PWA manifest and worker, and the configured issuer and endpoint origins in OIDC discovery. It follows neither redirects nor discovery endpoints. It sends no cookies, sign-in requests or mutations.

The command prints one JSON report and returns a nonzero exit status when a check fails. Use the public report together with [local monitoring](OPERATIONS_MONITORING.md) to distinguish public routing from backend readiness. Sign-in, registration, household boundaries, load and real mobile acceptance remain separate release gates in #31.

## Operator access

Before inviting alpha users, check that a regular signed-in account sees no SMTP or instance details on the operator APIs. Sign in with the configured operator account and complete the Identity MFA flow. Open the instance registry and the SMTP status page. Repeat after the five-minute proof expires and after logging out. An expired proof must require a fresh MFA sign-in, and a signed-out browser must lose access. The automated suite verifies the Gateway endpoint boundary, signed MFA evidence and database session lookup with fixtures. The hosted Identity flow still needs this separate check.
