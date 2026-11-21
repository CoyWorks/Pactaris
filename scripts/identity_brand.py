"""Plan or apply the reviewed cosmetic fields of one existing Authentik Brand."""

import argparse
import getpass
from hashlib import sha256
import json
import os
import re
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID, uuid4

from deploy import MESSAGES, DeployError, emit, public_origin, read_json

SOURCE = Path(__file__).resolve().parents[1]
BRANDING = SOURCE / 'apps/identity/branding'
MEDIA = {
    'branding_logo': 'pactaris/logo-dark.svg',
    'branding_favicon': 'pactaris/favicon.svg',
    'branding_default_flow_background': 'pactaris/flow-background.jpg',
}
FIELDS = ('branding_title', 'branding_custom_css', *MEDIA)
# Authentik renders a flow's raw title before its first challenge arrives, so the
# stock "%(app)s" placeholders leak into the page. Each designation gets a fixed title.
FLOW_TITLES = {
    'authentication': 'portal.signInTitle',
    'authorization': 'identity.redirectTitle',
    'invalidation': 'identity.signedOutTitle',
}


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(endpoint, token, patch=None):
    data = None if patch is None else json.dumps(patch).encode('utf-8')
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json', 'Content-Type': 'application/json'}
    req = Request(endpoint, data=data, headers=headers, method='GET' if patch is None else 'PATCH')
    with build_opener(NoRedirect()).open(req, timeout=10) as response:
        return json.loads(response.read(1_048_577))


def release_assets():
    assets = {}
    for field, name in MEDIA.items():
        path = BRANDING / Path(name).name
        content = path.read_bytes()
        remote = f'pactaris/{path.stem}-{sha256(content).hexdigest()[:20]}{path.suffix}'
        assets[field] = (remote, content)
    return assets


def asset_exists(origin, token, name):
    query = urlencode({'usage': 'media', 'search': name})
    files = request(f'{origin}/api/v3/admin/file/?{query}', token)
    if not isinstance(files, list) or any(not isinstance(item, dict) for item in files):
        raise ValueError('brand.invalid_file_response')
    return any(item.get('name') == name for item in files)


def upload_asset(origin, token, name, content):
    boundary = uuid4().hex
    filename = Path(name).name
    mime = 'image/svg+xml' if filename.endswith('.svg') else 'image/jpeg'
    form = (
        f'--{boundary}\r\nContent-Disposition: form-data; name="usage"\r\n\r\nmedia\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\n{name}\r\n'
        f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\n'
        f'Content-Type: {mime}\r\n\r\n'
    ).encode('ascii') + content + f'\r\n--{boundary}--\r\n'.encode('ascii')
    req = Request(f'{origin}/api/v3/admin/file/', data=form, method='POST', headers={
        'Authorization': f'Bearer {token}', 'Content-Type': f'multipart/form-data; boundary={boundary}',
    })
    try:
        with build_opener(NoRedirect()).open(req, timeout=10):
            pass
    except HTTPError as error:
        if error.code != 400 or not asset_exists(origin, token, name):
            raise


def messages(language):
    manifest = read_json(SOURCE / 'locales/manifest.json')
    return read_json(SOURCE / 'locales' / manifest['languages'][language]['messages'])


def desired_brand(language):
    return {
        'branding_title': messages(language)['app.title'],
        'branding_custom_css': (BRANDING / 'pactaris-authentik.css').read_text(encoding='utf-8'),
        **MEDIA,
    }


def brand_fields(value):
    return {field: value[field] for field in FIELDS if isinstance(value[field], str)}


def write_backup(backup, value):
    fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as file:
        json.dump(value, file, indent=2)
        file.write('\n')
        file.flush()
        os.fsync(file.fileno())


def change_brand(origin, brand_id, domain, language, token, apply, backup=None, restore=None, assets=False):
    endpoint = f'{origin}/api/v3/core/brands/{brand_id}/'
    current = request(endpoint, token)
    if current.get('brand_uuid') != brand_id or current.get('domain') != domain:
        raise DeployError('cli.brandMismatch')
    old = brand_fields(current)
    if len(old) != len(FIELDS):
        raise ValueError('brand.invalid_response')
    identity = {'origin': origin, 'brand': brand_id, 'domain': domain}
    if restore is None:
        desired = desired_brand(language)
    else:
        previous = read_json(restore)
        if previous['target'] != identity:
            raise DeployError('cli.brandMismatch')
        desired = brand_fields(previous['branding'])
        if len(desired) != len(FIELDS):
            raise ValueError('brand.invalid_backup')
    missing = []
    if assets:
        for field, (name, content) in release_assets().items():
            desired[field] = name
            if not asset_exists(origin, token, name):
                missing.append((name, content))
        emit('cli.brandAssets', files=[name for name, _ in missing])
    changes = {key: value for key, value in desired.items() if old[key] != value}
    if not apply or (not changes and not missing):
        emit('cli.brandPlan', origin=origin, domain=domain, fields=sorted(changes))
        return

    write_backup(backup, {'target': identity, 'branding': old})
    for name, content in missing:
        upload_asset(origin, token, name, content)
        if not asset_exists(origin, token, name):
            raise ValueError('brand.upload_missing')
    updated = request(endpoint, token, changes) if changes else request(endpoint, token)
    preserved = {'web_certificate', 'default', 'client_certificates', 'attributes'}
    preserved.update(key for key in current if key.startswith('flow_'))
    if (updated.get('domain') != domain or updated.get('brand_uuid') != brand_id
            or any(updated.get(key) != current.get(key) for key in preserved)
            or brand_fields(updated) != desired):
        raise DeployError('cli.brandVerify')
    emit('cli.brandApplied', domain=domain, fields=sorted(changes))


def change_flow(origin, slug, flow_id, language, token, apply, backup=None, restore=None):
    if not re.fullmatch(r'[a-zA-Z0-9_-]{1,100}', slug):
        raise ValueError('flow.invalid_slug')
    target = {'origin': origin, 'flow': flow_id, 'slug': slug}
    endpoint = f'{origin}/api/v3/flows/instances/{slug}/'
    current = request(endpoint, token)
    designation = current.get('designation')
    if current.get('pk') != flow_id or current.get('slug') != slug or designation not in FLOW_TITLES:
        raise DeployError('cli.brandFlowMismatch')
    old = current['title']
    desired = messages(language)[FLOW_TITLES[designation]]
    if restore is not None:
        previous = read_json(restore)
        if previous['target'] != target:
            raise DeployError('cli.brandFlowMismatch')
        desired = previous['title']
    if not isinstance(old, str) or not isinstance(desired, str):
        raise ValueError('flow.invalid_title')
    fields = [] if old == desired else ['title']
    if not fields or not apply:
        emit('cli.brandFlowPlan', slug=slug, fields=fields)
        return

    write_backup(backup, {'target': target, 'title': old})
    updated = request(endpoint, token, {'title': desired})
    preserved = ('pk', 'slug', 'designation', 'name', 'authentication',
                 'policy_engine_mode', 'compatibility_mode', 'denied_action', 'layout')
    if updated.get('title') != desired or any(updated.get(key) != current.get(key) for key in preserved):
        raise DeployError('cli.brandVerify')
    emit('cli.brandFlowApplied', slug=slug, fields=fields)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', type=Path, default=Path('/opt/pactaris'))
    target = parser.add_mutually_exclusive_group(required=True)
    target.add_argument('--brand', type=UUID)
    target.add_argument('--flow', type=UUID)
    parser.add_argument('--domain')
    parser.add_argument('--flow-slug')
    parser.add_argument('--upload-assets', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--restore', type=Path)
    args = parser.parse_args(argv)
    if args.brand is not None and (not args.domain or args.flow_slug is not None):
        parser.error('--brand requires --domain')
    if args.flow is not None and (not args.flow_slug or args.domain is not None):
        parser.error('--flow requires --flow-slug')
    if args.upload_assets and (args.brand is None or args.restore is not None):
        parser.error('--upload-assets requires --brand and cannot be combined with --restore')
    try:
        if args.apply and args.backup is None:
            raise DeployError('cli.brandBackupRequired')
        if not sys.stdin.isatty():
            raise DeployError('cli.brandTerminalRequired')
        config = read_json(args.root / 'identity/config.json')
        origin = public_origin(config['publicOrigin'])
        token = getpass.getpass(MESSAGES['cli.brandTokenPrompt']+' ').strip()
        if not token:
            raise ValueError('brand.missing_token')
        shared = (config['locale']['language'], token, args.apply, args.backup, args.restore)
        if args.brand is not None:
            change_brand(origin, str(args.brand), args.domain, *shared, assets=args.upload_assets)
        else:
            change_flow(origin, args.flow_slug, str(args.flow), *shared)
        return 0
    except DeployError as error:
        emit(error.key, **error.params)
    except HTTPError as error:
        emit('cli.brandFailed', status=error.code)
    except (OSError, ValueError, KeyError, TypeError):
        emit('cli.brandFailed')
    return 1


if __name__ == '__main__':
    sys.exit(main())
