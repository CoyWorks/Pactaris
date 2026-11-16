# Third-party components

Original project source remains proprietary under LICENSE.txt. Dependency/component rights remain independent; this notice does not relicense third-party code.

The lockfile records npm dependency versions and integrity metadata. Review their distributed license files before redistribution; do not remove them from installed artifacts. This foundation uses Express (MIT), React (MIT), Vite (MIT), TypeScript (Apache-2.0), node-postgres (MIT), Drizzle ORM (Apache-2.0) and FormatJS intl-messageformat (BSD-3-Clause), openid-client (MIT) and jose (MIT), plus their dependencies.

The Identity deployment references the externally distributed authentik and PostgreSQL container images. Their respective licenses and image contents remain governed by their upstream distributions. No identity-provider implementation source is copied into this repository. Retain upstream notices and review the selected image's terms before deployment/redistribution.

Deployment shape reference, checked 16 November 2026: https://docs.goauthentik.io/compose.yml and https://docs.goauthentik.io/install-config/install/docker-compose/ . The local definition removes Docker socket mounting, uses private data volumes and explicit port binding, and pins the selected candidate release.

This is an initial component inventory, not a completed license/compliance audit. Issue #50 remains open for complete provenance and dependency review.
