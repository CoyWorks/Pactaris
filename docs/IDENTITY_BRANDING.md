# Pactaris sign-in branding

This uses the corrected Pactaris artwork and CSS from the original Authentik branding kit. The PWA and Identity use the same icon. The Identity title comes from the Pactaris message catalog. Authentik controls the translated labels and instructions in its authentication flows.

## Prepare

1. Keep an authenticated administrator session open. In **System > Brands**, identify the existing Brand used for the public Identity hostname. If it uses the fallback Brand, record that Brand's actual domain field. Record its UUID, domain, and the assigned web certificate.
2. Use `--upload-assets` to prepare the branded media from this checkout. For a manual rollout, in **Customization > Files**, upload `logo-dark.svg`, `favicon.svg` and `flow-background.svg` from [apps/identity/branding](../apps/identity/branding). Use the folder `pactaris` for the new media paths. Keep previous files available for rollback.
3. Use an Authentik API token with permission to read and change that Brand. The upload option also requires Authentik permission to view and manage media. Enter it at the interactive prompt. Keep the backup in a root-only directory.

Run a preview from the reviewed checkout on the Identity host. Use the exact UUID and domain recorded above.

```bash
cd /opt/pactaris-source
python3 scripts/identity_brand.py --brand "$PACTARIS_BRAND_UUID" --domain "$PACTARIS_BRAND_DOMAIN" --upload-assets
```

Apply after reviewing the preview. The script writes a new mode-0600 backup before sending only the changed cosmetic fields to the existing Brand. The destination is the installed Identity public origin. An already matching Brand produces an empty preview.

```bash
python3 scripts/identity_brand.py --brand "$PACTARIS_BRAND_UUID" --domain "$PACTARIS_BRAND_DOMAIN" \
  --upload-assets --apply --backup /root/pactaris-brand-before.json
```

With the upload option, preview lists missing files. Apply uploads immutable, content-versioned filenames before updating the Brand. Existing assets are retained for rollback. A partial upload can be retried with a fresh backup path; the script reuses assets already present.

Confirm the public Identity URL and sign-in through the public app. Verify the existing web certificate and issuer, then test errors, aborting sign-in, MFA, recovery and mobile keyboard/focus with test accounts. For manual application, use the same files and CSS under **System > Brands**. Leave the existing routing, web certificate and flow selections in place.

Set the public flow heading separately. In **Flows and Stages > Flows**, identify the actual public Authentication flow and obtain its UUID (`pk`) and slug from the Authentik flow API. On the current deployment the slug is `default-authentication-flow`. Preview before applying. The utility changes only **Title** to the value of `portal.signInTitle` in [the message catalog](../locales/en/messages.json).

```bash
python3 scripts/identity_brand.py --flow "$PACTARIS_FLOW_UUID" --flow-slug "$PACTARIS_FLOW_SLUG"
python3 scripts/identity_brand.py --flow "$PACTARIS_FLOW_UUID" --flow-slug "$PACTARIS_FLOW_SLUG" \
  --apply --backup /root/pactaris-flow-before.json
python3 scripts/identity_brand.py --flow "$PACTARIS_FLOW_UUID" --flow-slug "$PACTARIS_FLOW_SLUG" \
  --restore /root/pactaris-flow-before.json --apply --backup /root/pactaris-flow-before-restore.json
```

Reopen the public sign-in page after applying. For a manual change, edit only **Title** and record its previous value for rollback. Preserve the flow name, slug, designation, stages and provider bindings.

Repeat this for the provider flows that the Pactaris applications use: `default-provider-authorization-explicit-consent` (and `default-provider-authorization-implicit-consent` if bound), and `default-provider-invalidation-flow`. Their stock titles contain the placeholder `%(app)s`. Authentik shows a flow's raw title until its first challenge loads, so users briefly see the placeholder while signing in or out. The utility sets authorization flows to `identity.redirectTitle` and invalidation flows to `identity.signedOutTitle`. It refuses any other designation.

To restore only the earlier cosmetic values, use that backup as input and a new path for the pre-restore snapshot.

```bash
python3 scripts/identity_brand.py --brand "$PACTARIS_BRAND_UUID" --domain "$PACTARIS_BRAND_DOMAIN" \
  --restore /root/pactaris-brand-before.json --apply --backup /root/pactaris-brand-before-restore.json
```

[Authentik Branding](https://docs.goauthentik.io/customize/branding/) · [File picker paths](https://docs.goauthentik.io/customize/file-picker/) · [Brand update API](https://api.goauthentik.io/reference/core-brands-partial-update/)

## Look and footer (25 November 2026)

Owner decision: Identity looks like the app and the main website on every flow.

- The flow background is `flow-background.svg`, the same dark gradient as the website hero. No flow has its own background, so every flow uses the Brand default.
- `pactaris-authentik.css` gives the flow card the app's surface colour, border and radius, and hides authentik's "Powered by authentik" footer line.
- Set manually, outside the script:
  - Brand attribute `{"settings": {"theme": {"base": "dark"}}}`: dark only, like the app.
  - **System > Settings > Footer links**: Privacy → `https://pactaris.app/privacy`, Terms → `https://pactaris.app/terms`.
- Flow titles without `%(app)s`:
  - `default-authentication-flow`: "Welcome to Pactaris"
  - both authorization flows: `identity.redirectTitle`
  - `default-provider-invalidation-flow`: `identity.signedOutTitle`

Since 25 November 2026 the Brand's logo, favicon and flow background point at the main website: `https://pactaris.app/logo.svg`, `/favicon.svg` and `/flow-background.svg`. Files uploaded to Identity's media storage disappeared twice after Identity was recreated, so Identity no longer depends on its own media storage for branding.

On the live Identity the Brand pointed at media files that no longer existed, so the logo and background were missing. The assets were uploaded again under content-versioned names and the Brand now points at those.

## Emails

Owner request, 25 November 2026: no authentik branding in emails either.

- `apps/identity/templates/pactaris-account-confirmation.html` is a self-contained Pactaris email. It uses the app colours and shows the Pactaris logo from `https://pactaris.app/logo-email.png` (a PNG, because mail clients do not show SVG; served by the main website, no attachment). It has a footer with Privacy and contact instead of "Powered by authentik". It uses only `url` and `user.username` from the email stage context.
- `apps/identity/compose.yaml` mounts `apps/identity/templates` read-only at `/templates` in the server and worker containers, where authentik looks for custom templates. The deploy script makes that folder readable for the container user.
- Both email stages use it: `pactaris-account-verify-email` and `pactaris-enrollment-email` (`template: pactaris-account-confirmation.html` in the blueprints). Switch a live stage to it only after the Identity release with the mount is running; authentik refuses a template it cannot find.
- The sender's display name comes from `AUTHENTIK_EMAIL__FROM` in `identity.env`, for example `Pactaris <info@pactaris.app>`.

## Rehearsal evidence

Run the apply and restore sequence against a disposable deployment of the same Identity image before rolling out to the live Brand. Capture the Brand domain, web certificate, selected flows and OIDC discovery issuer before and after both changes. Keep the application client and redirect configuration out of the change. Verify sign-in and cancelled sign-in from the app, then test MFA and recovery and record the device/browser used. The tool verifies the returned Brand after every write and keeps the pre-change snapshot if protected Brand settings differ. The automated fixture verifies detection and the backup; it does not exercise a running Identity provider.
