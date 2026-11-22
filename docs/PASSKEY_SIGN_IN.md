# Passkey sign-in and automatic sign-in in the app

Browser sessions keep their short default bounds (30 minutes idle, 8 hours absolute; see [LOGIN_GATEWAY.md](LOGIN_GATEWAY.md)). Signing in again should be quick instead. Two parts make that work:

1. **Automatic sign-in in the installed app.** When Pactaris runs as an installed app (standalone display mode) and finds no session, it goes straight to sign-in instead of showing the sign-in page. This happens only if this device signed in successfully before. An explicit **Sign out**, or deleting the account, turns it off until the next successful sign-in. A failed attempt is not repeated for two minutes, so a broken sign-in cannot loop. Ordinary browser tabs keep the sign-in button.
2. **Passkey sign-in in Identity.** If Identity still has its own session, sign-in finishes without a prompt. Otherwise the Identity sign-in page offers the device passkey (Face ID, fingerprint or device PIN) as the first factor, without a password.

The device screen lock protects the installed app. A session that was revoked elsewhere (**Manage sessions**) still ends the Pactaris session. The app then signs in again only through Identity, which applies its own session and passkey checks. To stop a lost device completely, also end its Identity session or remove its passkey in Identity.

## Identity configuration (Authentik)

Authentik 2026.8 supports passkeys as a first factor in the Identification stage, using conditional WebAuthn (passkey autofill). Change these settings in the Authentik admin interface. Test them with a spare account first.

1. **Enrollment.** In **Flows and Stages > Stages**, edit the WebAuthn setup stage used by `default-authenticator-webauthn-setup`. Set **User verification** to `required` and **Resident key requirement** to `required`. Passkey autofill needs discoverable credentials, and user verification is what makes a passkey a biometric or PIN check.
2. **Validation stage.** Create an Authenticator Validation stage, for example `pactaris-passkey-validation`. Set **Device classes** to WebAuthn only and **WebAuthn user verification** to `required`.
3. **Identification stage.** Edit the Identification stage of `default-authentication-flow`. Set **WebAuthn Authenticator Validation Stage** to the stage from step 2.
4. **Skip later factors after a passkey.** The default authentication flow already skips the password and MFA validation stages when `auth_method` is `auth_webauthn_pwl`. If the flow has been customised, check that these policy bindings still exist.
5. **Users add a passkey** under **Settings > MFA Devices** on Identity, from each phone or computer they use.

The passkey is bound to the Identity hostname. Create it on the same Identity origin that the app redirects to.

## MFA and operator access

Authentik reports a passkey sign-in as `amr: ["user"]` without `mfa`. By default the gateway therefore does not treat it as MFA, and the operator console asks for a separate MFA sign-in. Once step 1 and step 2 enforce user verification, the operator can opt in:

```json
"session": {"idleSeconds":1800,"absoluteSeconds":28800,"requireVerifiedEmail":false,"passkeyIsMfa":true}
```

With `passkeyIsMfa`, an `amr` that contains `user`, together with a valid `auth_time`, counts as fresh MFA. Do not enable this while Identity accepts passkeys without user verification, because then possession of the device alone would count as MFA.

## Testing

- Unit tests: `tests/auto-sign-in.test.ts` (device memory, standalone only, no loop, sign-out stops it) and `tests/oidc.test.ts` (`passkeyIsMfa` is off by default and requires `user` in `amr`).
- Live acceptance after configuration, on an installed iPhone and Android app:
  - The session expires, Identity's session is still valid, and the app is back without a prompt.
  - Identity's session has also expired, and a passkey prompt signs the user in.
  - After an explicit sign-out, the app shows the sign-in page.
  - With `passkeyIsMfa` enabled, the operator console accepts a passkey sign-in.
