# Creating an account

Owner decision, 25 November 2026: registration is open. People create a local Identity account themselves; registration can still be closed for new accounts in the operator console, except through invitations ([INVITATIONS.md](INVITATIONS.md#closed-registration)).

## Identity flow

Blueprint `apps/identity/blueprints/pactaris-enrollment.yaml`, flow `pactaris-enrollment`:

1. **Prompt:** username, email address, password twice, and "I am 18 years or older". Password policy: at least 10 characters and not trivially guessable (zxcvbn score 2). The 18+ box is required.
2. **User write:** creates the account as inactive.
3. **Email:** sends a confirmation link (30 minutes) and activates the account when it is opened.
4. **Login:** signs the person in. The policy on this binding records the confirmed address in `attributes.email_verified_address`, the same as `pactaris-account-verify-email`, so Pactaris receives `email_verified`.
5. **Redirect:** to `done_url` (`https://app.pactaris.app/auth/login`). The gateway then starts a normal sign-in, which completes immediately with the new Identity session.

The flow is reachable directly (`/if/flow/pactaris-enrollment/`, the site's "Create account") and as "Sign up" on the sign-in page once it is the identification stage's enrollment flow.

## Notes and limits

- The 18+ box in Identity does not replace the confirmation in the app ([AGE_CONFIRMATION.md](AGE_CONFIRMATION.md)); the app records its own.
- Two accounts may use the same email address; Pactaris does not merge them.
- Imported in the live Identity on 25 November 2026 but not yet linked to the sign-in page; that happens with the move to `app.pactaris.app` because `done_url` points there.
- Not yet tested end to end with a new mailbox; do that during the move.
