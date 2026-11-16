# Minimal-input installation and one public application origin

Decision: 16 November 2026. This is the required next installer experience, not a capability already shipped. The current alpha still requires the documented manual provisioning/configuration. Do not change the running CoyWorks deployment, issuer or client registrations as a side effect of adopting this design.

## Normal operator flow

The interactive installer asks for:

1. Components: **Identity**, **Instance**, or **both**.
2. Hostname: the service/backend FQDN for this installation, validated against the selected role and fleet configuration.

Use `pactaris.app` as the future default product-domain example. The default canonical application origin is `https://pactaris.app`, with `https://identity.pactaris.app` for the identity service. Both remain operator-configurable. Existing `https://www.coyworks.nl`/CoyWorks settings must be preserved until a deliberate cutover; this decision does not establish domain ownership, provision DNS or authorize a live migration.

The operator should not normally enter ports, database names/passwords, TLS names, file paths, OIDC client IDs/secrets or callback routes. Advanced overrides and unattended preserved configuration remain supported for split-host deployments, another public domain, existing infrastructure and nonstandard bindings. Do not change the machine's OS hostname merely because a service FQDN was entered.

A hostname alone cannot authenticate a server or grant access to DNS/provider accounts. Remote instances receive central public-origin/identity/manager configuration and a short-lived authenticated enrollment credential through a trusted manager-provisioned install profile/secure file. Do not derive trust or the base domain by stripping hostname labels, auto-enroll unknown servers or embed shared enrollment credentials in the repository. On a new central installation, derive defaults from the explicit installation profile and selected central hostname; validate and persist the resulting distinct origins.

## Automated work

- Detect supported OS/architecture/resources and provision the selected runtimes/dependencies using verified distribution/package sources and the pinned release policy. Detect existing installations before changing services.
- Create independent component service users, directories, databases, least-privilege roles, storage and workers. Generate and securely retain credentials and stable instance identity once.
- Bootstrap backend CA/trust enrollment and individual TLS certificates/keys; configure authentik's web certificate, NGINX verification/SNI and the Instance TLS identity automatically. Never copy a central CA signing key to remote instances.
- Enroll remote instances through the trusted management channel and obtain the required signed/certified configuration. Keep database/app ports private; preserve independently installable Identity and Instance components.
- Provision the central OIDC application/provider, exact public gateway callback/logout allowlists and client-secret delivery automatically. Preserve client IDs/secrets on repeats; rotate through a deliberate operation. Update the currently imported direct-instance blueprint through an explicit migration when gateway integration exists.
- Integrate CloudPanel ingress through supported configuration methods, or generate a ready-to-apply vhost and perform an explicit readiness check if automation is unavailable. Do not replace CloudPanel's NGINX, install another competing public proxy or overwrite unrelated sites. Identity/Instance installation does not blindly invoke the fresh-server CloudPanel installer on a populated host.
- Obtain public certificates when DNS/challenge prerequisites are available, and report the exact external prerequisite when they are not. Public reachability is not ready merely because local health passes.
- Install certificate expiry monitoring/renewal, propagate renewed public trust where needed, import renewed authentik certificates, reload only affected services and verify backend/public TLS. An unattended leaf renewal does not silently rotate the CA or OIDC issuer/signing keys.
- Initialize the first operator account through a protected bootstrap credential/session. Do not leave a publicly claimable initial-admin setup or print long-lived secrets. MFA enrollment remains an operator action.
- Run end-to-end readiness, service/reboot checks, and record component/release outcomes. Show progress and actionable private diagnostics; resume interrupted installs safely instead of telling the operator to delete files/volumes.
- Maintain the existing update guarantees: pinned revisions, locks, recovery checkpoints, preserved config/IDs/data, compatible migrations, independent activation and truthful rollback limits.

All installer-owned prompts/status/errors use semantic language keys and the English catalog. Operator-supplied hostnames/display labels remain configuration data.

## One-time external provisioning

Automatic setup may consume previously configured secrets from the operator secret store. It cannot invent access to external accounts. DNS/ACME account access, Google/Apple developer credentials and SMTP/sender settings are collected once centrally or supplied securely only when those features are enabled. Subsequent instance installs reuse centrally managed configuration without re-asking those questions or distributing social-login provider secrets to data-plane instances.

If public DNS, a proxy, source access or enrollment credentials are missing, report a blocked/pending stage with a resumable next action. Do not silently weaken TLS, publish a private Instance hostname or claim installation complete. These prerequisites are exceptions to the two-question happy path, not additional routine per-instance configuration.

## User-facing routing

Users open the canonical product origin and choose **households/dynamics they belong to**, never servers or Instances. After choosing a household, the central gateway resolves its registered placement and privately proxies to its home Instance. The browser stays on the canonical application origin, for example `/households/<household-id>/...`.

Instance hostnames/private addresses must not appear in browser redirects, callback targets, frontend API bases, attachment/download URLs, notifications, emails or user-visible errors. All content routes and generated public links use the configured product origin. Identity can use its separate configured login origin; placing the IDP itself under an application path is not part of this decision.

The shared-origin gateway requires an explicit session/trust design before OIDC implementation proceeds. Do not simply share a central cookie across private backends or treat NGINX headers as identity. Use a reviewed server-side session/token-exchange/delegation contract with instance-bound audience, current local household membership, revocation bounds and host-scoped browser cookies. Each Instance still enforces its own resource authorization. Never let a client-supplied household ID or URL select an arbitrary upstream.

The manager/placement directory contains only required operational and authorization metadata. Household content remains in the home Instance. Distinguish a manager outage from a failed public gateway: the gateway is a potential availability bottleneck even if individual backends remain healthy.

## Acceptance gates

- Fresh Identity-only, Instance-only and both-component installations use only component selection/hostname in a preprovisioned fleet environment.
- Bootstrap/setup uses no manual JSON edits, SQL, certificate copying, authentik shell commands, client-secret resets or blueprint uploads in the normal workflow.
- Exercise co-location and separate proxy/Identity/Instance hosts, private DNS, custom ports/origins and an unrelated configured product domain.
- Repeat install, resume at each interrupted stage, reboot and two-version update preserve IDs, credentials, data and unrelated sites. Test failed downloads/enrollment/backups/certificate issuance/renewal.
- Verify real provider registration and exact public callback; test rejected redirects/replays/wrong audiences, household switching on two distinct Instance stores and revoked membership.
- Browser/network/link inspection confirms one canonical application origin and no private Instance targets. Registering an Instance does not make it a household choice.
- Test renewal and expired/wrong-name/untrusted certificates: fail closed without publishing private endpoints. No test claims Google/Apple registration or SMTP works without real provider acceptance.

Implementation is tracked in #56 (installer), #58 (public gateway/identity/household routing) and #62 (deployed acceptance). These issues remain open.
