# Verified recipient identity foundation

Implemented in 0.3.1-alpha.1 for [#69](https://github.com/CoyWorks/Pactaris/issues/69), part of #6 and a prerequisite of #8. This is identity metadata, not an invitation or account-linking endpoint.

## Trust and storage

The existing maintained OIDC client validates the ID-token signature, issuer, audience, state, nonce and code/PKCE exchange before reading claims. Pactaris retains an email only when that validated token contains a string `email` and boolean `email_verified: true`. Strings such as `"true"`, missing/false flags, malformed addresses, headers, username/display name and browser input do not prove verification. No UserInfo/access-token fallback or token retention is added.

Gateway accounts remain keyed solely by issuer + subject. An email is not unique: two subjects with the same address remain separate accounts, including across issuers. Apple relay addresses and plus aliases remain distinct; no alias guessing or automatic account linking is performed.

The additive gateway migration `0004_verified_email` adds nullable `verified_email` and `verified_email_asserted_at` to accounts. The timestamp records when this gateway observed the provider assertion at login, not when the provider verified ownership or when the user last authenticated. New and existing accounts without proof start unknown. Every successful account login replaces both fields; a missing, unverified or unusable claim clears an earlier assertion. Suspended accounts cannot refresh metadata or create sessions.

The bounded mailbox subset accepts ASCII dot-atom local parts up to 64 characters, DNS-style domains and at most 254 characters overall. Domain case folds; local-part case, dots and plus tags remain unchanged. Punycode DNS labels are accepted. Quoted local parts, raw internationalized addresses, whitespace, controls and domain literals are deliberately unsupported for recipient matching in this slice. An unsupported address does not block ordinary subject-based sign-in. This is format validation, not a deliverability check or independent proof of ownership.

Email stays inside the gateway identity boundary and protected database backups. It is not added to `Account`/browser session responses, household responses, Instance payloads, audit events or logs. Runtime remains non-owner; migration and read-only backup credentials remain separate and root-only.

## Provider and freshness requirements

The configured IdP must actually verify the address before asserting boolean true and must clear verification after a user changes it. Do not hardcode true in a scope mapping or bulk-mark existing profile emails verified. Requesting the `email` scope alone does not establish verification. This release preserves the working authentik configuration, certificate/Brand association and client credentials; it does not edit provider mappings or registration flows.

There is no live email-change/revocation event feed. A changed IdP assertion is observed only at the next OIDC login. Existing valid sessions remain valid and do not carry their own recipient proof. **Future invitation acceptance must require a recent provider assertion tied to the accepting session, with a defined expiry and reauthentication path; it must not authorize from this cached account column alone.** The observation timestamp alone is not recent-authentication evidence: another session can refresh an account. No authorization currently consumes these columns.

Real local registration/verification/recovery/MFA and Google/Apple acceptance remain #6. No SMTP delivery or social-provider rollout is implied by passing signed-token fixtures. OIDC claim semantics: [OpenID Connect Core, Standard Claims](https://openid.net/specs/openid-connect-core-1_0.html#StandardClaims).

## Update and verification

Use the existing root command:

```bash
bash /opt/pactaris-source/update.sh
```

The updater keeps mandatory backups, checksummed additive migrations and independent component health gates. Existing accounts, sessions, issuer/subject IDs, household data and deployment configuration are preserved. Sign out and sign in again to obtain the current provider assertion; an existing session does not invent verification. Identity is not restarted for this metadata migration.

Tests cover signed verified/unverified/malformed claims, wrong signatures/issuer/audience/nonce, email alias preservation, same-email distinct accounts, replacement/removal, suspended-account immutability, session projection and upgrading a populated pre-migration gateway with its old session rows intact. Native PostgreSQL/HTTPS integration also exercises the existing two-Instance create/leave and routing boundaries.

Before invitations can ship, [#70](https://github.com/CoyWorks/Pactaris/issues/70) must bind membership history, commands and central hints to an exact membership ID. Rejoining must create a new membership, without restoring old consent/roles, and delayed old leave/create receipts must not affect it. #8 then adds explicit preview/accept/decline/revoke, single-use opaque tokens, recipient proof freshness, member quota reservations and durable routing recovery.
