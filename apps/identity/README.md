# Identity deployment candidate

This independently deployable component pins authentik 2026.8.5 from its official Compose definition checked on 16 November 2026. It is an evaluation candidate, not a verified production identity service.

No provider source code is copied into this repository. authentik and PostgreSQL retain their own licenses. Compose deployment guidance: https://docs.goauthentik.io/install-config/install/docker-compose/ .

The installer creates a private environment file, stable Compose project and volumes. No PostgreSQL port or Docker socket is exposed. Internal HTTPS defaults to 9443. Run Identity separately from the Instance's Node/systemd processes. The installer requires an existing Docker Compose v2 runtime; it does not install Docker or CloudPanel.

After deployment, configure the admin/bootstrap account, English-only brand/flows, verified local registration, SMTP/recovery, Google/Apple sources, signing key and an OIDC client with exact instance callback/logout URLs. Never treat a reachable login page as proof these workflows work. Default provider certificates must be replaced/configured for the intended trusted backend TLS identity before CloudPanel production acceptance; never disable upstream verification.

The current installer verifies provider containers and liveness inside the container network. Full external TLS, OIDC, Google and Apple flows still need real-server acceptance. No credentials are seeded or displayed.

## OIDC application import

An operator-imported blueprint for the first Instance is provided in `blueprints/pactaris-instance1.yaml`. See [IDENTITY_OIDC.md](../../docs/IDENTITY_OIDC.md) for configurable deployment values, credential preservation, import steps and verification limits. This prepares the provider; the Instance callback/session runtime is not implemented yet.

## Central SMTP

For the shared account SMTP settings and verification/recovery acceptance, see [Central account email](../../docs/CENTRAL_SMTP.md).

## Sign-in branding

The Pactaris assets and explicit preview/apply/restore workflow are documented in [IDENTITY_BRANDING.md](../../docs/IDENTITY_BRANDING.md).
