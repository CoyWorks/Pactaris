# Public ingress smoke checks

Run from a client outside the deployment network after a Pactaris update or CloudPanel change. Pass the exact public gateway origin and the configured issuer, including its trailing slash when present.

```bash
python3 scripts/public_smoke.py \
  --app-origin https://pactaris.app \
  --issuer 'https://identity.pactaris.app/application/o/pactaris/'
```

The check uses HTTPS with normal certificate verification. It checks gateway readiness, the logged-out session response and cache policy, the PWA manifest and worker, and the configured issuer and endpoint origins in OIDC discovery. It follows neither redirects nor discovery endpoints. It sends no cookies, sign-in requests or mutations.

The command prints one JSON report and returns a nonzero exit status when a check fails. Use the public report together with [local monitoring](OPERATIONS_MONITORING.md) to distinguish public routing from backend readiness. Sign-in, registration, household boundaries, load and real mobile acceptance remain separate release gates in #31.
