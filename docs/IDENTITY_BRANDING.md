# Pactaris sign-in branding

This uses the corrected Pactaris artwork and CSS from the original Authentik branding kit. The PWA and Identity use the same icon. The Identity title comes from the Pactaris message catalog. Authentik controls the translated labels and instructions in its authentication flows.

## Prepare

1. Keep an authenticated administrator session open. In **System > Brands**, identify the existing Brand used for the public Identity hostname. If it uses the fallback Brand, record that Brand's actual domain field. Record its UUID, domain, and the assigned web certificate.
2. In **Customization > Files**, upload `logo-dark.svg`, `favicon.svg` and `flow-background.jpg` from [apps/identity/branding](../apps/identity/branding). Use the folder `pactaris` for the new media paths. Keep previous files available for rollback.
3. Use an Authentik API token with permission to read and change that Brand. Enter it at the interactive prompt. Keep the backup in a root-only directory.

Run a preview from the reviewed checkout on the Identity host. Use the exact UUID and domain recorded above.

```bash
cd /opt/pactaris-source
python3 scripts/identity_brand.py --brand "$PACTARIS_BRAND_UUID" --domain "$PACTARIS_BRAND_DOMAIN"
```

Apply after reviewing the preview. The script writes a new mode-0600 backup before sending only the changed cosmetic fields to the existing Brand. The destination is the installed Identity public origin. An already matching Brand produces an empty preview.

```bash
python3 scripts/identity_brand.py --brand "$PACTARIS_BRAND_UUID" --domain "$PACTARIS_BRAND_DOMAIN" \
  --apply --backup /root/pactaris-brand-before.json
```

Confirm the public Identity URL and sign-in through the public app. Verify the existing web certificate and issuer, then test errors, aborting sign-in, MFA, recovery and mobile keyboard/focus with test accounts. For manual application, use the same files and CSS under **System > Brands**. Leave the existing routing, web certificate and flow selections in place.

To restore only the earlier cosmetic values, use that backup as input and a new path for the pre-restore snapshot.

```bash
python3 scripts/identity_brand.py --brand "$PACTARIS_BRAND_UUID" --domain "$PACTARIS_BRAND_DOMAIN" \
  --restore /root/pactaris-brand-before.json --apply --backup /root/pactaris-brand-before-restore.json
```

[Authentik Branding](https://docs.goauthentik.io/customize/branding/) · [File picker paths](https://docs.goauthentik.io/customize/file-picker/) · [Brand update API](https://api.goauthentik.io/reference/core-brands-partial-update/)
