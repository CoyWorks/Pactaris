# Verified recipient identity foundation

Update: 0.4.0-alpha.1 now implements [session-bound recipient assertions and explicit participant invitations](INVITATIONS.md). The 0.3.1 foundation and its original non-authorization boundary are described below; the earlier statement that sessions have no recipient proof applies to releases before 0.4.0. New sessions snapshot the actual callback's assertion, require a five-minute bound and an exact current account assertion match. Cached account email alone still cannot authorize joining.

Implemented in 0.3.1-alpha.1 for [#69](https://github.com/CoyWorks/Pactaris/issues/69), part of #6 and a prerequisite of #8. This is identity metadata, not an invitation or account-linking endpoint.

## Trust and storage

The existing maintained OIDC client validates the ID-token signature, issuer, audience, state, nonce and code/PKCE exchange before reading claims. Pactaris retains an email only when that validated token contains a string `email` and boolean `email_verified: true`. Strings such as `"true"`, missing/false flags, malformed addresses, headers, username/display name and browser input do not prove verification. No UserInfo/access-token fallback or token retention is added.

Gateway accounts remain keyed solely by issuer + subject. An email is not unique: two subjects with the same address remain separate accounts, including across issuers. Apple relay addresses and plus aliases remain distinct; no alias guessing or automatic account linking is performed.

The additive gateway migration `0004_verified_email` adds nullable `verified_email` and `verified_email_asserted_at` to accounts. The timestamp records when this gateway observed the provider assertion at login, not when the provider verified ownership or when the user last authenticated. New and existing accounts without proof start unknown. Every successful account login replaces both fields; a missing, unverified or unusable claim clears an earlier assertion. Suspended accounts cannot refresh metadata or create sessions.

The bounded mailbox subset accepts ASCII dot-atom local parts up to 64 characters, DNS-style domains and at most 254 characters overall. Domain case folds; local-part case, dots and plus tags remain unchanged. Punycode DNS labels are accepted. Quoted local parts, raw internationalized addresses, whitespace, controls and domain literals are deliberately unsupported for recipient matching in this slice. An unsupported address does not block ordinary subject-based sign-in. This is format validation, not a deliverability check or independent proof of ownership.

Email stays inside the gateway identity boundary and protected database backups. Only a Boolean `emailVerified` (whether this session carries a confirmed address) is added to the browser session response, so the app can ask the person to confirm their address. The address itself is not added to `Account`/browser session responses, household responses, Instance payloads, audit events or logs. Runtime remains non-owner; migration and read-only backup credentials remain separate and root-only.

## Provider and freshness requirements

The configured IdP must actually verify the address before asserting boolean true and must clear verification after a user changes it. Do not hardcode true in a scope mapping or bulk-mark existing profile emails verified. Requesting the `email` scope alone does not establish verification. The `pactaris-email` mapping below derives the claim from an address the person confirmed by email.

There is no live email-change/revocation event feed. A changed IdP assertion is observed only at the next OIDC login. Existing valid sessions remain valid and do not carry their own recipient proof. **Future invitation acceptance must require a recent provider assertion tied to the accepting session, with a defined expiry and reauthentication path; it must not authorize from this cached account column alone.** The observation timestamp alone is not recent-authentication evidence: another session can refresh an account. No authorization currently consumes these columns.

Real local registration/verification/recovery/MFA and Google/Apple acceptance remain #6. No SMTP delivery or social-provider rollout is implied by passing signed-token fixtures. OIDC claim semantics: [OpenID Connect Core, Standard Claims](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims).

## Confirming addresses in Identity (owner decision, 25 November 2026)

Since authentik 2025.10, the default `email` scope mapping asserts `email_verified: false` for everyone, because authentik has no authoritative verification state. Pactaris requires a confirmed address to preview and accept invitations, so without this setup no invitation can be accepted. The live UI test of 25 November 2026 found exactly that. Identity confirms addresses itself, using its own SMTP:

- **Flow** `pactaris-account-verify-email` (`apps/identity/blueprints/pactaris-account.yaml`):
  1. A policy makes the signed-in person the pending user.
  2. The mandatory email stage (`email/account_confirmation.html`, link valid for 30 minutes) sends a link to the account's current address.
  3. After the link is opened, a policy on the final binding records `attributes.email_verified_address`. It records only when the flow token belongs to the same account.
  4. A redirect stage sends the person to Pactaris `/auth/login`, so the next ID token carries the new claim.
- **Scope mapping** `pactaris-email` replaces the managed email mapping on the Pactaris provider. It returns `email_verified: true` only while the current email equals `email_verified_address`, so changing the address makes it unconfirmed again. Do not assign both email mappings to the provider.
- **In Pactaris:** while a session has no confirmed address (`emailVerified: false`), the dynamics list and the profile show **Confirm your email address**. **Sign-in and security** shows the status. An invitation that fails for this reason asks the person to confirm first, rather than to sign in again. If the address is confirmed and the sign-in is older than five minutes, the invitation asks for a fresh sign-in (`/auth/reauth`).

Live setup steps are in [ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md).

## Update and verification

Use the existing root command:

```bash
bash /opt/pactaris-source/update.sh
```

The updater keeps mandatory backups, checksummed additive migrations and independent component health gates. Existing accounts, sessions, issuer/subject IDs, household data and deployment configuration are preserved. Sign out and sign in again to obtain the current provider assertion; an existing session does not invent verification. Identity is not restarted for this metadata migration.

Tests cover signed verified/unverified/malformed claims, wrong signatures/issuer/audience/nonce, email alias preservation, same-email distinct accounts, replacement/removal, suspended-account immutability, session projection and upgrading a populated pre-migration gateway with its old session rows intact. Native PostgreSQL/HTTPS integration also exercises the existing two-Instance create/leave and routing boundaries.

Before invitations can ship, [#70](https://github.com/CoyWorks/Pactaris/issues/70) must bind membership history, commands and central hints to an exact membership ID. Rejoining must create a new membership, without restoring old consent/roles, and delayed old leave/create receipts must not affect it. #8 then adds explicit preview/accept/decline/revoke, single-use opaque tokens, recipient proof freshness, member quota reservations and durable routing recovery.


## Require verified email for Pactaris sessions

The gateway can enforce the provider's verified email assertion before it creates a session. Keep the default compatibility mode until the installed Authentik provider, local enrollment, recovery and configured social sources have passed their actual sign-in checks. See [CENTRAL_SMTP.md](CENTRAL_SMTP.md).

Set `session.requireVerifiedEmail` to `true` in the installed gateway configuration and restart the gateway API and worker, or apply the gateway update with that setting in place. The strict policy requires a validated OIDC ID token with a supported email address and a Boolean verified claim. A mail address in an editable Authentik profile does not establish verification. Old browser sessions without a session-bound verified address need to sign in again. An existing session also fails strict validation if its verified address differs from the account's current provider assertion.

With test accounts, confirm that local verification and each enabled social source can reach Pactaris, that an unverified account sees a verification prompt, and that an old unverified session is denied after activation. Restore `false` and restart the gateway if the installed provider does not yet emit the required claim. Keep the issuer and existing provider account mapping stable.
