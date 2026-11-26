# Pactaris operator access

Operator access uses a gateway installation allowlist of OIDC `sub` values in `operatorSubjects`. Values must come from the configured issuer and its existing Pactaris provider, since provider subject modes can differ. Configure the list in the protected gateway configuration. An empty list disables operator authorization.

Configure Authentik to require an authenticator for the designated accounts. Test authentication and the Authentik recovery flow with a spare operator before applying it to production. Pactaris trusts a validated ID token only when Authentik asserts `mfa` in `amr` and supplies a numeric `auth_time`. With `session.passkeyIsMfa` enabled, a passkey sign-in (`user` in `amr`) also counts; see [PASSKEY_SIGN_IN.md](PASSKEY_SIGN_IN.md). Redirection to Authentik or membership in a household does not grant operator access.

Sign in at `/auth/operator` to request a fresh Authentik login. `GET /api/operator/session` checks the current session and the allowlist and requires provider authentication within the last five minutes. Authenticate again before operating after that window. Session revocation invalidates this access, and editing the allowlist takes effect when the gateway reloads its configuration.

Acceptance on the deployed provider must cover fresh MFA, stale MFA, an ordinary account with MFA, a recovery-code sign-in, session revocation and operator removal. The repository tests exercise the claim and authorization checks. Live Authentik enforcement and recovery need the deployment configuration and test accounts.

[Authentik credentials and recovery codes](https://docs.goauthentik.io/users-sources/user/user-interface/#credentials)

## Operator console

`/operator` is the console. Every section loads on its own and a failing section logs `operator.failed` with its name to the gateway service log, so one fault never hides the rest.

| Section | What an operator sees and can do |
| --- | --- |
| Overview | Counts: open reports, accounts by status, new accounts in 7 days, accounts signed in, active households, invitation-mail queue, households per instance. |
| Reports | Open or closed, filtered by category; the report text, reporter account and optional household ID; internal notes (operators only); close as actioned/no action/duplicate; reopen; delete for good (notes included; the audit log keeps that it happened). |
| Accounts | Search by email, name or account ID and filter by status; detail with created, last sign-in, active sessions, reports filed, household IDs with member counts, and operator actions on the account; suspend or restore. |
| Households | Household ID, instance, registry status and member count. No names or content: those live only on the instances. |
| Instances | The registry inventory (unchanged). |
| Maintenance | Daily cleanup on the gateway and every instance: recent runs, largest tables, proof storage, preview and run now. See [MAINTENANCE.md](MAINTENANCE.md). |
| Settings | Operators (see below); new accounts open or closed; how long closed reports are kept; a platform-wide announcement (information or warning, at most 300 characters) shown at the top of every page; invitation email (SMTP). |
| Audit log | Every operator change: report closed, reopened or noted, account suspended or restored, settings changed. |

**Operators.** The `operatorSubjects` in the gateway configuration are the bootstrap operators: an empty list keeps the console off, and they can only be removed in the configuration. From an account's page an operator can **make another account operator** or remove that access again; such grants are stored in `pactaris.operator_grants`, are limited to accounts of the configured issuer, and cannot remove one's own access. Every operator, configured or granted, still needs a multi-factor sign-in within the last five minutes to act.

Settings use a version number, so two operators cannot overwrite each other unnoticed. While new accounts are closed, a person without an account is refused at sign-in, unless they arrive through a valid invitation (owner decision, 25 November 2026; see [INVITATIONS.md](INVITATIONS.md#closed-registration)); existing accounts and allow-listed operators can always sign in. Stored SMTP settings that can no longer be decrypted (for example after a key change) no longer break the console: the defaults are shown with a warning and can be saved again. A refused or unreachable relay answers `smtp_failed` instead of a generic error.


## Plans

In **Households**, opening a dynamic shows its plan ([HOUSEHOLD_PLANS.md](HOUSEHOLD_PLANS.md)). There you can add months of a level, set extra member places, and pause, resume or stop the dynamic's subscription. Each change is recorded in the audit log.
