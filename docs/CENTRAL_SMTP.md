# Central account email

Configure SMTP once on the central Identity host. Authentik's server and worker use the same settings. Every Pactaris instance using that Identity issuer shares the resulting account email flows.

## Configure the relay

As root, edit the existing `/opt/pactaris/identity/identity.env` in place. Keep the other keys and retain mode 0600 with root ownership. Use your actual sender and provider values. This example uses authenticated STARTTLS.

```dotenv
AUTHENTIK_EMAIL__HOST=smtp.example.org
AUTHENTIK_EMAIL__PORT=587
AUTHENTIK_EMAIL__USERNAME=mailer@example.org
AUTHENTIK_EMAIL__PASSWORD='replace-on-the-identity-host'
AUTHENTIK_EMAIL__FROM=mailer@example.org
AUTHENTIK_EMAIL__USE_TLS=true
AUTHENTIK_EMAIL__USE_SSL=false
AUTHENTIK_EMAIL__TIMEOUT=10
```

For implicit TLS, use your provider's port (commonly 465), set USE_TLS=false and USE_SSL=true. For an authorized unauthenticated relay, leave username and password empty. Keep passwords in the private environment file and out of shell arguments and git. Single quotes are Compose syntax to preserve literal dollar signs. Use the provider's authorized sender address and sender-domain DNS settings.

Apply the first deployment that contains the SMTP Compose settings using the normal updater on the Identity host.

```bash
bash /opt/pactaris-source/update.sh --component identity
```

For future changes to the environment file alone, run the following as root from a login shell. The updater detects changes in the Compose definition, so an environment-only change needs container recreation. Use the stable project name from the installer and its active release, and avoid running this alongside another update.

```bash
base=/opt/pactaris/identity
suffix=$(printf '%s' "$base" | sha256sum | cut -c1-12)
compose=(docker compose --project-name "pactaris-identity-$suffix"
  --env-file "$base/identity.env" -f "$base/current/apps/identity/compose.yaml")
"${compose[@]}" up -d --wait --no-deps server worker
"${compose[@]}" exec worker ak test_email YOUR_TEST_ADDRESS
```

The same test command can be used immediately after the initial update. Confirm receipt in the test mailbox.

## Account flow acceptance

In Authentik, set the Email stages for local enrollment verification and recovery to **Use global connection settings**. Make email verification mandatory before granting verified account access. Keep the existing gateway's signed OIDC email verification rules and never map an unverified editable email to a verified claim.

With a fresh test account, check registration, receipt and consumption of the verification link, then sign in to Pactaris. Check password recovery, rejection of an expired or consumed link and authenticator enrollment and recovery for the administrator. Keep an active operator session during MFA rollout until a second operator sign-in and its recovery path succeed.

The Pactaris household invitation flow currently creates links for manual delivery. Sending those automatically and tracking delivery requires the application mail job work in #24.

Provider documents: [Email configuration](https://docs.goauthentik.io/install-config/email/), [Email stage](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/email/), [Verified OIDC email](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/).

## Pactaris session recovery

The household selector includes **Sign out other Pactaris sessions**. After confirmation, the gateway removes the account's other application sessions and keeps the current browser signed in. The command requires the current session, the application origin and CSRF proof. It also clears matching local restrictive safety routes from the handling gateway process. Authentik independently controls provider sessions, MFA and recovery codes.

Verify with a test account in two browsers. Sign out the other sessions from the first browser and confirm the second browser loses API access on refresh.
