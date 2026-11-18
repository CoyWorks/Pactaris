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

## Automatic invitation email

Enable invitation email once on the central gateway. Each Instance keeps deciding whether its invitation is valid. The gateway uses the configured relay to send a generic message with a link at the configured Pactaris origin. Use the same relay as Identity if desired. Keep SMTP access and encryption keys on the central hosts.

Create a JSON file such as `/opt/pactaris/gateway/data/invitation-mail.json`, owned by root and readable by the gateway service group only (mode 0640). In `/opt/pactaris/gateway/config.json`, set `"invitationMailFile": "/opt/pactaris/gateway/data/invitation-mail.json"`. The file uses this shape:

```json
{
  "host": "smtp.example.org",
  "port": 587,
  "tls": "starttls",
  "from": "mailer@example.org",
  "username": "mailer@example.org",
  "password": "replace-on-the-gateway-host",
  "encryptionKey": "replace-with-64-hex-characters"
}
```

Generate the queue encryption key with `openssl rand -hex 32`. Retain it across updates while work is queued and protect backups containing it. Use `"tls": "implicit"` with the provider's implicit TLS port if required. Omit both login fields for an authorized relay without SMTP authentication. Disable link tracking/wrapping for these messages so the invite fragment stays intact and avoids provider tracking URLs.

Update the gateway using `bash /opt/pactaris-source/update.sh --component gateway`. When modifying settings on a running revision, restart the gateway API and worker to reload the file. Invites can still be shared manually. The queue encrypts the address and invitation token, removes them at terminal state, and retries temporary failures at bounded intervals. The worker revalidates each invitation immediately before delivery. SMTP acceptance means that the relay accepted the message. Delivery may repeat if the process stops after relay acceptance and before the database records it. The invitation itself is single-use.

Verify with a test dynamic and mailbox. Create an invitation, check that the generic email reaches the mailbox with a link on the public app origin, and use the invited account to review it. Exercise a temporary relay failure and revoke a queued invitation before retrying. Retain manual sharing as a fallback until delivery is verified.

Provider documents: [Email configuration](https://docs.goauthentik.io/install-config/email/), [Email stage](https://docs.goauthentik.io/add-secure-apps/flows-stages/stages/email/), [Verified OIDC email](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/verify-email-address/).

## Pactaris session recovery

The household selector includes **Sign out other Pactaris sessions**. After confirmation, the gateway removes the account's other application sessions and keeps the current browser signed in. The command requires the current session, the application origin and CSRF proof. It also clears matching local restrictive safety routes from the handling gateway process. Authentik independently controls provider sessions, MFA and recovery codes.

Verify with a test account in two browsers. Sign out the other sessions from the first browser and confirm the second browser loses API access on refresh.
