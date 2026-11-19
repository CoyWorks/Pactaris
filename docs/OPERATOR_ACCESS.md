# Pactaris operator access

Operator access uses a gateway installation allowlist of OIDC `sub` values in `operatorSubjects`. Values must come from the configured issuer and its existing Pactaris provider, since provider subject modes can differ. Configure the list in the protected gateway configuration. An empty list disables operator authorization.

Configure Authentik to require an authenticator for the designated accounts. Test authentication and the Authentik recovery flow with a spare operator before applying it to production. Pactaris trusts a validated ID token only when Authentik asserts `mfa` in `amr` and supplies a numeric `auth_time`. Redirection to Authentik or membership in a household does not grant operator access.

Sign in at `/auth/operator` to request a fresh Authentik login. `GET /api/operator/session` checks the current session and the allowlist and requires provider authentication within the last five minutes. Authenticate again before operating after that window. Session revocation invalidates this access, and editing the allowlist takes effect when the gateway reloads its configuration.

Acceptance on the deployed provider must cover fresh MFA, stale MFA, an ordinary account with MFA, a recovery-code sign-in, session revocation and operator removal. The repository tests exercise the claim and authorization checks. Live Authentik enforcement and recovery need the deployment configuration and test accounts.

[Authentik credentials and recovery codes](https://docs.goauthentik.io/users-sources/user/user-interface/#credentials)
