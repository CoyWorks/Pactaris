# Import the Pactaris Instance OIDC configuration

This prepares authentik 2026.8.5 for the first Instance. It creates/configures an application, confidential OIDC provider and minimal profile scope mapping. It does not implement the Pactaris callback/session handlers. The deployed foundation still reports `authentication: not_enabled` and returns HTTP 401 from `/api/session`.

## Settings

Source: [pactaris-instance1.yaml](../apps/identity/blueprints/pactaris-instance1.yaml).

| Setting | Value |
| --- | --- |
| Application | Pactaris Instance 1 |
| Slug | `pactaris-instance1` |
| Provider | `Pactaris-Instance1-OIDC` |
| Authorization flow | `default-provider-authorization-explicit-consent` |
| Client type | Confidential |
| Grant types | Authorization Code only |
| Callback | `https://instance1.coyworks.nl/auth/oidc/callback`, exact/strict |
| Scopes | `openid`, minimal `profile`, `email` |
| Issuer mode | Per provider |
| Subject | Hashed stable user identifier, never email |
| Signing key | Existing `authentik Self-signed Certificate` |
| Code lifetime | 1 minute |
| Access-token lifetime | 5 minutes |

The public domains and display names are deployment data in the blueprint's `context` block. Edit them before uploading if deploying elsewhere. For another Instance, also change the slug, provider name and profile mapping name so applications do not overwrite each other. Keep an existing deployed application's slug and client identifiers stable. Blueprint instance context can override the defaults when using a managed blueprint instance.

The callback path `/auth/oidc/callback` is now the agreed contract for future Instance implementation (#6/#58); it does not exist in the current runtime. The launch URL points to the status page until login support is implemented. Logout redirects, refresh tokens, manager routing, registration, Google/Apple sources and SMTP are outside this import.

The existing signing certificate is separate from `Pactaris-Identity-TLS`, which remains the webserver/backend HTTPS certificate. Do not rotate signing keys as part of this import.

## Import

1. Cancel an unfinished application/provider wizard without saving it.
2. Download the YAML file from the reviewed repository commit to your computer.
3. Open the authentik Admin interface and navigate to **Customization > Blueprints > Import**.
4. Choose **File upload**, select `pactaris-instance1.yaml`, then import.
5. Confirm the import succeeds. Check **Applications > Applications** for `Pactaris Instance 1` and its linked provider `Pactaris-Instance1-OIDC`.
6. Open the provider and record its generated client ID and secret in your operator secret store. The earlier unsaved wizard's client ID is not reused. Never commit the secret or paste it into chat. Backend secret-file wiring will ship with the OIDC implementation.

The default authorization/invalidation flows, managed `openid`/`email` scope mappings and default signing certificate must already exist. Missing dependencies should fail the import, rather than falling back to weaker settings.

This is a one-time import, not an automatically reapplied filesystem blueprint. The same file can be reimported: matching objects are identified by provider/profile names and application slug. Explicitly listed attributes are reapplied; omitted client ID and secret fields remain unchanged. Do not delete/recreate the provider to make settings changes.

If the application/provider was already saved manually, first inspect its name, slug and current association. The blueprint rebinds the target application slug to the provider with the configured name; a differently named existing provider is not automatically adopted or deleted. Align the context to the intended existing provider before importing if retaining that client's credentials.

No user/group/policy bindings or household access are created. A new application has authentik's default access behavior; importing it is not household authorization or proof of account verification. The minimal profile mapping deliberately excludes central groups; default email mapping semantics are preserved, including an unverified email claim when applicable. Future Pactaris account linking must never assume a returned email is verified.

## Verify registration

After successful import:

```bash
curl --fail --silent --show-error \
  https://identity.coyworks.nl/application/o/pactaris-instance1/.well-known/openid-configuration \
  | python3 -m json.tool
```

Expected issuer: `https://identity.coyworks.nl/application/o/pactaris-instance1/`. Confirm the document contains authorization/token/JWKS endpoints on the expected Identity origin. Discovery proves provider registration, not end-to-end login.

The future backend must use Authorization Code + PKCE S256, state and nonce validation, exact issuer/audience/signature checks and a host-scoped secure HttpOnly session. This blueprint does not itself enforce PKCE for a confidential client; client implementation and negative-flow tests are still required. A future direct native client needs its own public-client registration rather than distributing this confidential secret.

## Verification limits

The YAML structure and resolved attributes are checked against the upstream blueprint schema and the pinned 2026.8.5 model/serializer definitions. No authentik runtime/import integration test was performed in the development environment. Treat the first actual import and discovery check as operator acceptance, and keep #6/#58 open until callback/session and actual login tests pass.

References:

- [Working with blueprints](https://docs.goauthentik.io/customize/blueprints/working_with_blueprints/)
- [Blueprint file structure and secret preservation](https://docs.goauthentik.io/customize/blueprints/v1/structure/)
- [Blueprint tags](https://docs.goauthentik.io/customize/blueprints/v1/tags/)
- [OAuth2/OIDC provider](https://docs.goauthentik.io/add-secure-apps/providers/oauth2/)
