"""Plan or apply the reviewed cosmetic fields of one existing Authentik Brand."""

import argparse
import getpass
import json
import os
import re
from pathlib import Path
import sys
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener
from uuid import UUID

from deploy import MESSAGES, DeployError, emit, public_origin, read_json

SOURCE = Path(__file__).resolve().parents[1]
BRANDING = SOURCE / 'apps/identity/branding'
MEDIA = {
    'branding_logo': 'pactaris/logo-dark.svg',
    'branding_favicon': 'pactaris/favicon.svg',
    'branding_default_flow_background': 'pactaris/flow-background.jpg',
}
FIELDS = ('branding_title', 'branding_custom_css', *MEDIA)


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def request(endpoint, token, patch=None):
    data = None if patch is None else json.dumps(patch).encode('utf-8')
    headers = {'Authorization': f'Bearer {token}', 'Accept': 'application/json', 'Content-Type': 'application/json'}
    req = Request(endpoint, data=data, headers=headers, method='GET' if patch is None else 'PATCH')
    with build_opener(NoRedirect()).open(req, timeout=10) as response:
        return json.loads(response.read(1_048_577))


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


def change_brand(origin, brand_id, domain, language, token, apply, backup=None, restore=None):
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
    changes = {key: value for key, value in desired.items() if old[key] != value}
    if not changes or not apply:
        emit('cli.brandPlan', origin=origin, domain=domain, fields=sorted(changes))
        return

    write_backup(backup, {'target': identity, 'branding': old})
    updated = request(endpoint, token, changes)
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
    if (current.get('pk') != flow_id or current.get('slug') != slug
            or current.get('designation') != 'authentication'):
        raise DeployError('cli.brandFlowMismatch')
    old = current['title']
    desired = messages(language)['portal.signInTitle']
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
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--backup', type=Path)
    parser.add_argument('--restore', type=Path)
    args = parser.parse_args(argv)
    if args.brand is not None and (not args.domain or args.flow_slug is not None):
        parser.error('--brand requires --domain')
    if args.flow is not None and (not args.flow_slug or args.domain is not None):
        parser.error('--flow requires --flow-slug')
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
            change_brand(origin, str(args.brand), args.domain, *shared)
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
