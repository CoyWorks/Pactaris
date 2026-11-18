"""Read-only smoke checks for the public Pactaris gateway and OIDC discovery."""

import http.client
import json
from urllib.parse import urlsplit
import sys

from deploy import DeployError, Parser, emit, public_origin


def get(url):
    target = urlsplit(url)
    connection = http.client.HTTPSConnection(target.hostname, target.port, timeout=4)
    try:
        connection.request('GET', target.path or '/', headers={'Cache-Control': 'no-cache'})
        response = connection.getresponse()
        body = response.read(65537)
        if len(body) > 65536:
            raise ValueError('smoke.response_size')
        return response.status, response.headers, body
    finally:
        connection.close()


def endpoint_origin(value):
    parts = urlsplit(value)
    if parts.fragment or parts.query:
        raise ValueError('smoke.endpoint')
    return public_origin(f'{parts.scheme}://{parts.netloc}')


def smoke(app, issuer):
    identity_origin = endpoint_origin(issuer)
    checks = {}

    def check(name, url, status, validate):
        try:
            code, headers, body = get(url)
            checks[name] = code == status and bool(validate(headers, body))
        except (DeployError, OSError, ValueError, AttributeError, TypeError, http.client.HTTPException):
            checks[name] = False

    def no_store(headers):
        return 'no-store' in {part.strip().lower() for part in headers.get('Cache-Control', '').split(',')}

    def discovery(_headers, body):
        value = json.loads(body)
        return (value.get('issuer') == issuer and all(
            endpoint_origin(value.get(key, '')) == identity_origin
            for key in ('authorization_endpoint', 'token_endpoint', 'jwks_uri')
        ))

    check('gatewayReady', app + '/health/ready', 200, lambda headers, body:
          no_store(headers) and json.loads(body).get('status') == 'ready')
    check('anonymousSession', app + '/api/session', 401, lambda headers, body:
          no_store(headers) and json.loads(body).get('code') == 'authentication_required')
    check('installManifest', app + '/manifest.webmanifest', 200, lambda headers, body:
          headers.get('Content-Type', '').startswith('application/manifest+json')
          and json.loads(body).get('start_url') == '/')
    check('serviceWorker', app + '/service-worker.js', 200, lambda headers, _body:
          no_store(headers) and 'javascript' in headers.get('Content-Type', ''))
    check('identityDiscovery', issuer.rstrip('/') + '/.well-known/openid-configuration', 200, discovery)
    return checks


def main(argv=None):
    parser = Parser(add_help=False)
    parser.add_argument('--app-origin', required=True)
    parser.add_argument('--issuer', required=True)
    try:
        args = parser.parse_args(argv)
        checks = smoke(public_origin(args.app_origin), args.issuer)
        passed = all(checks.values())
        emit('cli.publicSmoke', checks=checks, passed=passed)
        return 0 if passed else 1
    except (DeployError, ValueError):
        emit('cli.publicSmokeInvalid')
        return 1


if __name__ == '__main__':
    sys.exit(main())
