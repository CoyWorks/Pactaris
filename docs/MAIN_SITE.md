# Main website and the app on its own origin

Owner decision, 25 November 2026: the public main website lives at `pactaris.app` (with `www.pactaris.app` redirecting to it) and the app moves to `app.pactaris.app`.

## What the site is

- Home (what Pactaris is, features, consent and safety, privacy, FAQ), Privacy and Terms. The legal pages are marked as drafts until legal review; the legal name and address are a placeholder.
- Rendered once at gateway start from `apps/site/site.ts`. All text comes from the `site.*` keys in `locales/en/messages.json`; the logo and symbol are those in `apps/identity/branding`.
- No cookies, no scripts, no forms and no API. Its own CSP (`default-src 'none'; style-src 'self'; img-src 'self'`), HSTS on HTTPS, short public caching.
- "Sign in" goes to `<app>/auth/login`. "Create account" goes to `site.signUpUrl` (the Identity enrollment flow, [ACCOUNT_CREATION.md](ACCOUNT_CREATION.md)) or, without it, to sign-in.
- Contact: `info@pactaris.app`. Footer: "A CoyWorks project".

## How it is served

The gateway serves the site for requests whose `Host` is the configured `site.origin` or one of `site.aliases` (`apps/gateway/site-routes.ts`); every other host goes to the app as before. On the site origin:

- An alias redirects (308) to the same path on `site.origin`.
- Former app paths (`/auth`, `/api`, `/households`, `/join`, `/profile`, `/operator`) redirect (308) to the same path and query on the app origin. Browsers keep the URL fragment across a redirect, so invitation links (`/join#…`) keep working.
- Anything else that is not a site page returns the site's 404 page, including `/service-worker.js`, so the old installed app's service worker unregisters itself.

## Gateway configuration after the move

```json
"publicOrigin": "https://app.pactaris.app",
"delegation": { "issuer": "https://pactaris.app", "keyId": "…", "privateKeyFile": "…" },
"site": {
  "origin": "https://pactaris.app",
  "aliases": ["https://www.pactaris.app"],
  "signUpUrl": "https://identity.pactaris.app/if/flow/pactaris-enrollment/"
}
```

`delegation.issuer` is optional and defaults to `publicOrigin`. It is only an identifier the Instances trust; keeping the earlier value means the Instance configuration does not change. The site's hosts must differ from the app's.

## Move checklist

Completed on 25 November 2026; the old callback `https://pactaris.app/auth/oidc/callback` has been removed from the provider. Kept for reference and for other installations.

Order matters: the app keeps working on the old origin until step 4.

1. **DNS:** `app.pactaris.app` (A/AAAA to the proxy). `pactaris.app` and `www.pactaris.app` keep pointing at the proxy.
2. **CloudPanel:** a site or vhost for `app.pactaris.app` with a TLS certificate, proxying to the gateway exactly like `pactaris.app` does today (same upstream, same `Host` passed through). Add `www.pactaris.app` to the certificate and proxy it to the gateway as well. Keep `pactaris.app` proxying to the gateway. All three keep the existing backend TLS settings from [LOGIN_ROLLOUT.md](LOGIN_ROLLOUT.md), including `proxy_ssl_name pactaris.app;`: the gateway's internal certificate does not change. The www redirect is now done by the gateway, so remove any www-to-apex redirect for app paths in CloudPanel or keep it; both end on the site.
3. **Identity (authentik):**
   - Provider `Pactaris-Instance1-OIDC`: add the redirect URI `https://app.pactaris.app/auth/oidc/callback` (strict). Keep the old one until the move is verified, then remove it.
   - Application launch URL: `https://app.pactaris.app/`.
   - Redirect stages `pactaris-account-return` → `https://app.pactaris.app/profile` and `pactaris-account-return-verified` → `https://app.pactaris.app/auth/login`.
   - Import `pactaris-enrollment.yaml` and set flow `pactaris-enrollment` as the enrollment flow of `default-authentication-identification` ([ACCOUNT_CREATION.md](ACCOUNT_CREATION.md)).
4. **Gateway config** (`/etc/pactaris/…/gateway` config): set `publicOrigin`, `delegation.issuer` and `site` as above, then restart the gateway.
5. **Check:**
   - `https://pactaris.app/` shows the site, and `https://www.pactaris.app/` redirects to it.
   - `https://app.pactaris.app/` signs in.
   - An old invitation link on `pactaris.app/join#…` opens the invitation in the app.
   - Push notifications: a phone that had the old app installed must reinstall from `app.pactaris.app` and allow notifications again.

Everyone signs in once more after the move: session cookies are bound to the host.
