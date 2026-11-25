# Native app sign-in with a fingerprint (planned)

Status: design, not implemented. Owner decision, 25 November 2026:

- **Web** (browser and installed web app): always the full login. That is username, password and, if set up, a second step. See [PASSKEY_SIGN_IN.md](PASSKEY_SIGN_IN.md).
- **Future native app:** the app remembers the username. On a phone that is on the account's trusted list, signing in only needs the fingerprint or face check.

## Proposed design

1. **First sign-in is the full login.** The app opens Identity in the system browser (ASWebAuthenticationSession on iOS, Custom Tabs on Android). Identity asks for username, password and the second step. The app never sees the password.
2. **Trust this phone.** After a full login, at most five minutes ago, the app offers "Sign in with fingerprint on this phone". If the person agrees:
   - The app creates a key pair in the Secure Enclave or Android Keystore. The private key cannot be exported. Every use requires a biometric check, and a new fingerprint or face enrollment invalidates the key (`setInvalidatedByBiometricEnrollment`).
   - The app sends the public key and a device name to the gateway. The gateway stores the device on the account's trusted list.
3. **Later sign-ins.** The app shows the remembered username and asks for the fingerprint. It requests a one-time challenge from the gateway, signs it with the device key after the biometric check, and receives an app session (`session.app` bounds). The gateway checks:
   - the signature, and that the challenge is fresh and single-use
   - that the device is on the trusted list and not revoked
   - that the account is active
   - that the last full login is no more than N days old (proposed: 30)
4. **Trusted list.** The app can ask the gateway whether this phone is still trusted for the account, and if not, falls back to the full login. **Profile > Signed-in devices** shows trusted phones with their last use, and each can be removed. Account deletion, suspension, "sign out everywhere" and changing the password revoke all trusted phones.
5. **Not MFA for operator work.** A fingerprint sign-in gives an ordinary session. The operator console keeps asking for a fresh full login with MFA.

Pactaris stores only public keys and device metadata. Biometric data never leaves the phone.

## Alternative considered

Native passkeys through the platform credential APIs against Identity. This needs `assetlinks.json` and `apple-app-site-association` on the Identity domain. It also depends on the Android Credential Manager, which failed on the owner's phone in November 2026 with "an unknown error occurred while talking to the credential manager", even on webauthn.io. The device key at the gateway gives Pactaris its own trusted list, its own revocation and a clear fallback.

## Open questions

- How many days may pass between full logins on a trusted phone: 30, 90, or never?
- Are household-sensitive actions, such as consent changes and leaving a household, allowed after a fingerprint sign-in, or do they ask for the full login?
- If Identity disables a user, the gateway does not know right away. The periodic full login limits the gap. Alternatively, the gateway could check the user's status at Identity on each fingerprint sign-in, which needs one more read permission.
