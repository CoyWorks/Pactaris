# Sign-in and security in Pactaris

People manage their password, passkeys (Face ID, fingerprint, device PIN), authenticator app and recovery codes from **Profile > Sign-in and security**. They do not need the Identity (Authentik) user interface. Owner decision, 22 November 2026: Identity stays the owner of all credentials (option A). Pactaris does not store, see or set passwords or authenticator secrets.

## How it works

| Action | Where it happens |
|---|---|
| See your passkeys, authenticator apps and recovery codes | Pactaris. The gateway asks Identity for this person's own devices. |
| Remove one | Pactaris, after a sign-in in the last five minutes. The gateway first checks that the device belongs to this person, then deletes it in Identity. |
| Change password, add a passkey, authenticator app or recovery codes | A short flow on Identity in Pactaris styling. It ends with a redirect back to `/profile`. |

- **Adding a method needs Identity's own page.** Passkeys are bound to the Identity hostname, so creating one must happen there. The same holds for password checks and authenticator secrets, which never pass through the gateway.
- **Each flow** requires an Identity session. Without one, the link signs in at Identity first and then continues with the same flow. The password flow asks for the current password first. Before a new passkey, authenticator app or recovery codes are added, people who already have a method confirm it, unless they used one in the last five minutes.
- **Identity user number:** the gateway knows which Identity user to ask about through the `pactaris_identity_user` claim (Identity's internal user number) in the ID token. The gateway stores it as `accounts.identity_user_id` at sign-in and clears it when the account is deleted. Accounts that signed in before this claim existed see "Sign in again once" until their next sign-in.
- **Service account:** the gateway calls Identity with an API token of the service account `pactaris-gateway-account`. Its role can only view and delete TOTP, WebAuthn and static (recovery) devices. It cannot change passwords, users or flows.

## Setup on Identity (Authentik 2026.8)

1. **Import the blueprint.** Import `apps/identity/blueprints/pactaris-account.yaml` (**Customization > Blueprints**, or upload it as a file). If the public origin is not `https://pactaris.app`, set the context `return_url` to the configured public origin plus `/profile`. The blueprint creates:
   - the flows `pactaris-account-password`, `-passkey`, `-totp` and `-recovery`
   - the stages `pactaris-account-return`, `pactaris-account-current-password` and `pactaris-account-reverify`
   - the role and the service account

   The flows reuse the default password prompt and write stages, and the default TOTP, WebAuthn and static setup stages. Passkey settings (user verification and a resident key) come from [PASSKEY_SIGN_IN.md](PASSKEY_SIGN_IN.md).
2. **Add the claim.** In the profile scope mapping of the Pactaris provider (`pactaris-profile`, or `pactaris-instance1-profile` on the first deployment), add `"pactaris_identity_user": request.user.pk`. The repository blueprints include it.
3. **Create a token.** In **Directory > Tokens and App passwords**, create a token for `pactaris-gateway-account` with intent **API** and no expiry. Copy the key once.
4. **Store the token.** Write it next to the gateway's `oidc.clientSecretFile`, in the gateway secrets folder (`/opt/pactaris/gateway/secrets/identity-account.token` on the first deployment). Give it the same owner, group and mode (`root:<gateway service user>`, `0640`). The service runs with `ProtectSystem=strict`. It cannot enter `/etc/pactaris/bootstrap/login`, which is root-only on purpose because it holds migration and backup credentials. Never commit the token. Check that the service user can read it:

```bash
S=$(python3 -c "import json;print(json.load(open('/opt/pactaris/gateway/config.json'))['oidc']['clientSecretFile'])")
N=$(dirname "$S")/identity-account.token
read -rs TOKEN && printf '%s' "$TOKEN" > "$N" && unset TOKEN
chown --reference="$S" "$N" && chmod --reference="$S" "$N"
sudo -u "$(stat -c %G "$S")" test -r "$N" && echo readable
```
5. **Configure the gateway and restart it:**

```json
"accountSecurity": {"tokenFile":"/opt/pactaris/gateway/secrets/identity-account.token"}
```

Optional fields:
- `identityOrigin`: defaults to the issuer's origin.
- `loginFlow`: defaults to `default-authentication-flow`.
- `flows`: per-flow slugs (`password`, `totp`, `passkey`, `recovery`).

Without `accountSecurity`, the profile page says that sign-in settings are not available.

## Troubleshooting

When the page says your sign-in methods could not be loaded, the gateway logs `account_security.unavailable` with a reason. The log never contains the token.

| Reason | Meaning |
|---|---|
| `token_unreadable` | The service cannot read `tokenFile`. Check the file's owner and mode, and that it is outside root-only folders. |
| `token_invalid` | The file is empty or contains whitespace inside the token. |
| `token_rejected` | Identity answered 401 or 403: the token was deleted, or the role lost its permissions. |
| `network` | Identity was unreachable or slower than 6 seconds. |
| `http_<status>` / `invalid_body` | Identity returned an unexpected answer. |

```bash
journalctl -u 'pactaris-gateway-*' --since '-1 hour' --no-pager | grep account_security
```

## Rollback

- Remove `accountSecurity` from the gateway config and restart. The page then shows the not-available message.
- Delete the token in Identity.
- The flows can stay. They change nothing unless someone opens them.

## Testing

- `tests/account-security.test.ts`:
  - only confirmed authenticator devices are listed
  - the ownership check runs before a delete
  - malformed ids never reach Identity
  - a rejected token is read again
  - links sign in first
  - the claim and the config are strict
- `tests/gateway.test.ts`: authentication, CSRF, fresh sign-in before removal, "sign in again" without an identity user, and not available when unconfigured.
- `tests/postgres.integration.ts`: the identity user number persists across sign-ins that omit it.
- Live acceptance, after setup:
  - Add a passkey on an iPhone and on an Android phone from the profile, and return to the profile.
  - Change the password, with a wrong current password first.
  - Add an authenticator app and recovery codes. Remove each one, first with a stale sign-in, then fresh.
  - Confirm that the service-account token cannot open `/api/v3/core/users/`.
