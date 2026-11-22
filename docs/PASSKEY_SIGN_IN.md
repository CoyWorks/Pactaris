# App sessions, automatic sign-in and passkeys

Browser sessions keep their short default bounds (30 minutes idle, 8 hours absolute; see [LOGIN_GATEWAY.md](LOGIN_GATEWAY.md)). The installed app works differently: the device screen lock protects it, so it may stay signed in.

1. **App sessions.** In standalone display mode, every sign-in link adds `client=app`, and the gateway creates a session with `session.app` bounds. The defaults are **one week without activity** and **90 days at most**. Any use of the app within the week extends the session. Only a week without contact (phone off, no internet, app not used) ends it. Each session stores its own idle bound, so later changes to the browser bounds do not shorten existing app sessions. `client=app` is a convenience signal from the client, not a security boundary: anyone can request it for their own sign-in. Operator sign-in (`/auth/operator`) always gets browser bounds.
2. **Automatic sign-in.** When an app session has ended, the installed app goes straight to sign-in instead of showing the sign-in page. This happens only if this device signed in successfully before. An explicit **Sign out**, or deleting the account, turns it off until the next successful sign-in. A failed attempt is not repeated for two minutes, so a broken sign-in cannot loop. Ordinary browser tabs keep the sign-in button.
3. **Passkeys (optional, recommended).** If Identity still has its own session, sign-in finishes without a prompt. Otherwise people can sign in with a passkey (Face ID, fingerprint or device PIN) instead of a password, if they have added one. Passkeys are not required. Password plus the existing MFA keeps working.

A session revoked elsewhere (**Manage sessions**) still ends the Pactaris session. The app then signs in again only through Identity, which applies its own session and passkey checks. To lock out a lost device completely, also end its Identity session or remove its passkey in Identity.

```json
"session": {"idleSeconds":1800,"absoluteSeconds":28800,"app":{"idleSeconds":604800,"absoluteSeconds":7776000}}
```

The app idle bound must be at least the browser idle bound and at most 30 days. The app absolute bound must be at least the app idle bound and the browser absolute bound, and at most 365 days.

## Identity configuration (Authentik)

Authentik 2026.8 supports passkeys as a first factor in the Identification stage, using conditional WebAuthn (passkey autofill). Change these settings in the Authentik admin interface. Test them with a spare account first.

1. **Enrollment.** In **Flows and Stages > Stages**, edit the WebAuthn setup stage used by `default-authenticator-webauthn-setup`. Set **User verification** to `required` and **Resident key requirement** to `required`. Passkey autofill needs discoverable credentials, and user verification is what makes a passkey a biometric or PIN check.
2. **Validation stage.** Create an Authenticator Validation stage, for example `pactaris-passkey-validation`. Set **Device classes** to WebAuthn only and **WebAuthn user verification** to `required`.
3. **Identification stage.** Edit the Identification stage of `default-authentication-flow`. Set **WebAuthn Authenticator Validation Stage** to the stage from step 2.
4. **Skip later factors after a passkey.** The default authentication flow already skips the password and MFA validation stages when `auth_method` is `auth_webauthn_pwl`. If the flow has been customised, check that these policy bindings still exist.
5. **Users who want a passkey add one** under **Settings > MFA Devices** on Identity, from each phone or computer they use. This is optional and recommended.

The passkey is bound to the Identity hostname. Create it on the same Identity origin that the app redirects to.

## MFA and operator access

Authentik reports a passkey sign-in as `amr: ["user"]` without `mfa`. By default the gateway therefore does not treat it as MFA, and the operator console asks for a separate MFA sign-in. Once step 1 and step 2 enforce user verification, the operator can opt in:

```json
"session": {"idleSeconds":1800,"absoluteSeconds":28800,"requireVerifiedEmail":false,"passkeyIsMfa":true}
```

With `passkeyIsMfa`, an `amr` that contains `user`, together with a valid `auth_time`, counts as fresh MFA. Do not enable this while Identity accepts passkeys without user verification, because then possession of the device alone would count as MFA.

## Testing

- Unit tests: `tests/auto-sign-in.test.ts` (device memory, standalone only, no loop, sign-out stops it, app sign-in links), `tests/gateway.test.ts` (app and browser bounds; operator never gets app bounds), `tests/config.test.ts` (app bound validation) and `tests/oidc.test.ts` (`passkeyIsMfa` is off by default and requires `user` in `amr`).
- `tests/postgres.integration.ts`: a session keeps its own idle bound, and the login attempt carries the client.
- Live acceptance after configuration, on an installed iPhone and Android app:
  - The app stays signed in across days of normal use, and a browser tab still expires after 30 minutes.
  - The session expires, Identity's session is still valid, and the app is back without a prompt.
  - Identity's session has also expired, and a passkey prompt signs the user in.
  - After an explicit sign-out, the app shows the sign-in page.
  - With `passkeyIsMfa` enabled, the operator console accepts a passkey sign-in.
