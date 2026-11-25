# App sessions, automatic sign-in and passkeys

Owner decision, 25 November 2026: on the web, sign-in is always the full login: username, password and, if set up, a second step. Passkeys and security keys (for example a YubiKey) are that second step, not a replacement for the password. Signing in with only a fingerprint is reserved for the future native app on a trusted device ([NATIVE_APP_SIGN_IN.md](NATIVE_APP_SIGN_IN.md)).

Browser sessions keep their short default bounds (30 minutes idle, 8 hours absolute; see [LOGIN_GATEWAY.md](LOGIN_GATEWAY.md)). The installed app works differently: the device screen lock protects it, so it may stay signed in.

1. **App sessions.** In standalone display mode, every sign-in link adds `client=app`, and the gateway creates a session with `session.app` bounds. The defaults are **one week without activity** and **90 days at most**. Any use of the app within the week extends the session. Only a week without contact (phone off, no internet, app not used) ends it. Each session stores its own idle bound, so later changes to the browser bounds do not shorten existing app sessions. `client=app` is a convenience signal from the client, not a security boundary: anyone can request it for their own sign-in. Operator sign-in (`/auth/operator`) always gets browser bounds.
2. **Automatic sign-in.** When an app session has ended, the installed app goes straight to sign-in instead of showing the sign-in page. This happens only if this device signed in successfully before. An explicit **Sign out**, or deleting the account, turns it off until the next successful sign-in. A failed attempt is not repeated for two minutes, so a broken sign-in cannot loop. Ordinary browser tabs keep the sign-in button.
3. **Passkeys and security keys (optional, recommended).** If Identity still has its own session, sign-in finishes without a prompt. Otherwise people sign in with their password, and then confirm with a passkey, security key or authenticator code if they have one.

A session revoked elsewhere (**Manage sessions**) still ends the Pactaris session. The app then signs in again only through Identity, which applies its own session and passkey checks. To lock out a lost device completely, also end its Identity session or remove its passkey in Identity.

```json
"session": {"idleSeconds":1800,"absoluteSeconds":28800,"app":{"idleSeconds":604800,"absoluteSeconds":7776000}}
```

The app idle bound must be at least the browser idle bound and at most 30 days. The app absolute bound must be at least the app idle bound and the browser absolute bound, and at most 365 days.

## Identity configuration (Authentik)

- **Identification stage:** the Identification stage of `default-authentication-flow` has **no** WebAuthn Authenticator Validation Stage. That turns passkey autofill off, so a passkey cannot replace the password. This was briefly enabled on 22 November 2026 and turned off on 25 November 2026. The unused stage `pactaris-passkey-validation` can stay or be deleted.
- **Second step:** `default-authentication-mfa-validation` allows WebAuthn, TOTP and recovery codes as the second step after the password. It skips the step for people who have none.
- **Enrollment:** the WebAuthn setup stage (`default-authenticator-webauthn-setup`) requires user verification and a resident key. A security key therefore asks for its PIN or fingerprint each time.
- **Adding a method:** people add passkeys, security keys, authenticator apps and recovery codes from **Profile > Sign-in and security** in Pactaris ([ACCOUNT_SECURITY.md](ACCOUNT_SECURITY.md)).

## MFA and operator access

A password followed by a passkey, security key or authenticator code gives `amr` with `mfa`. That counts as MFA for the operator console with no extra setting. `session.passkeyIsMfa` only matters for passkey-only sign-in (`amr: ["user"]`). The web no longer offers that, so leave the setting off.

## Testing

- Unit tests: `tests/auto-sign-in.test.ts` (device memory, standalone only, no loop, sign-out stops it, app sign-in links), `tests/gateway.test.ts` (app and browser bounds; operator never gets app bounds), `tests/config.test.ts` (app bound validation) and `tests/oidc.test.ts` (`passkeyIsMfa` is off by default and requires `user` in `amr`).
- `tests/postgres.integration.ts`: a session keeps its own idle bound, and the login attempt carries the client.
- Live acceptance after configuration, on an installed iPhone and Android app:
  - The app stays signed in across days of normal use, and a browser tab still expires after 30 minutes.
  - The session expires, Identity's session is still valid, and the app is back without a prompt.
  - On the web, the Identity sign-in page asks for username and password and does not offer passkey autofill. A security key works as the second step.
  - Identity's session has also expired, and the full login (password, then the second step) signs the user in.
  - After an explicit sign-out, the app shows the sign-in page.
  - With `passkeyIsMfa` enabled, the operator console accepts a passkey sign-in.
