import importlib.util
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch


scripts = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('public_smoke', scripts / 'public_smoke.py')
smoke = importlib.util.module_from_spec(spec)
with patch.object(sys, 'path', [str(scripts), *sys.path]):
    spec.loader.exec_module(smoke)


class SmokeTests(unittest.TestCase):
    def test_public_check_rejects_login_redirects_and_discovery_off_origin(self):
        app = 'https://app.example.invalid'
        identity = 'https://identity.example.invalid'
        issuer = identity + '/application/o/pactaris/'
        privacy = {'Cache-Control': 'no-store, no-transform'}
        discovery = {
            'issuer': issuer, 'authorization_endpoint': identity + '/authorize',
            'token_endpoint': identity + '/token', 'jwks_uri': identity + '/jwks',
        }
        responses = {
            '/health/ready': (200, privacy, '{"status":"ready"}'),
            '/api/session': (401, privacy, '{"code":"authentication_required"}'),
            '/manifest.webmanifest': (200, {'Content-Type': 'application/manifest+json'}, '{"start_url":"/"}'),
            '/service-worker.js': (200, {**privacy, 'Content-Type': 'text/javascript'}, 'script'),
        }
        def get(url):
            if url.startswith(app + '/'):
                return responses[url[len(app):]]
            self.assertEqual(url, issuer + '.well-known/openid-configuration')
            return 200, {}, json.dumps(discovery)

        with patch.object(smoke, 'get', side_effect=get):
            self.assertTrue(all(smoke.smoke(app, issuer).values()))
            responses['/api/session'] = (302, privacy, '')
            discovery['jwks_uri'] = 'https://unrelated.example.invalid/jwks'
            report = smoke.smoke(app, issuer)
            self.assertFalse(report['anonymousSession'])
            self.assertFalse(report['identityDiscovery'])
            self.assertTrue(report['gatewayReady'])
