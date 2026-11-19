import importlib.util
import json
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest.mock import patch


scripts = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('identity_brand', scripts / 'identity_brand.py')
brand = importlib.util.module_from_spec(spec)
with patch.object(sys, 'path', [str(scripts), *sys.path]):
    spec.loader.exec_module(brand)


class IdentityBrandTests(unittest.TestCase):
    def test_apply_and_restore_only_change_cosmetic_fields(self):
        origin, domain = 'https://identity.example.invalid', 'authentik-default'
        brand_id = '6aef4af8-9d3d-4efa-be12-4d719e6e411c'
        old = dict.fromkeys(brand.FIELDS, 'legacy')
        current = {'brand_uuid': brand_id, 'domain': domain, 'web_certificate': 'fixture-cert',
                   'flow_authentication': 'fixture-flow', **old}
        desired = brand.desired_brand('en')
        with tempfile.TemporaryDirectory() as temp:
            backup = Path(temp) / 'before.json'
            rollback_backup = Path(temp) / 'before-restore.json'
            def request(endpoint, token, patch_data=None):
                self.assertEqual(endpoint, f'{origin}/api/v3/core/brands/{brand_id}/')
                if patch_data is not None:
                    self.assertTrue(backup.is_file())
                    self.assertLessEqual(patch_data.keys(), set(brand.FIELDS))
                    current.update(patch_data)
                return dict(current)

            with patch.object(brand, 'request', side_effect=request) as api, patch.object(brand, 'emit'):
                args = (origin, brand_id, domain, 'en', 'fixture-token')
                brand.change_brand(*args, False)
                api.assert_called_once()
                brand.change_brand(*args, True, backup)
                self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
                self.assertEqual(json.loads(backup.read_text())['branding'], old)
                self.assertEqual(brand.brand_fields(current), desired)
                brand.change_brand(*args, True, backup)
                brand.change_brand(*args, True, rollback_backup, backup)
                self.assertEqual(brand.brand_fields(current), old)
                self.assertEqual(current['web_certificate'], 'fixture-cert')
                self.assertEqual(current['flow_authentication'], 'fixture-flow')

    def test_wrong_brand_domain_stops_after_read(self):
        with patch.object(brand, 'request', return_value={'brand_uuid': 'id', 'domain': 'other'}) as api:
            with self.assertRaises(brand.DeployError):
                brand.change_brand('https://identity.example.invalid', 'id', 'expected', 'en', 'fixture-token', True)
            api.assert_called_once()

    def test_changed_authentication_flow_fails_verification_and_keeps_backup(self):
        origin = 'https://identity.example.invalid'
        brand_id = '6aef4af8-9d3d-4efa-be12-4d719e6e411c'
        current = dict.fromkeys(brand.FIELDS, 'legacy')
        current.update(brand_uuid=brand_id, domain='authentik-default', flow_authentication='previous')
        patched = dict(current, **brand.desired_brand('en'))
        patched['flow_authentication'] = 'changed'
        with tempfile.TemporaryDirectory() as temp:
            backup = Path(temp) / 'before.json'
            with patch.object(brand, 'request', side_effect=[current, patched]):
                with self.assertRaises(brand.DeployError) as failure:
                    brand.change_brand(origin, brand_id, current['domain'], 'en', 'fixture-token', True, backup)
            self.assertEqual(failure.exception.key, 'cli.brandVerify')
            self.assertEqual(json.loads(backup.read_text())['target']['brand'], brand_id)

    def test_flow_title_preview_apply_restore_and_exact_identity(self):
        origin = 'https://identity.example.invalid'
        slug = 'public-login'
        flow_id = '6aef4af8-9d3d-4efa-be12-4d719e6e411c'
        current = {'pk': flow_id, 'slug': slug, 'designation': 'authentication',
                   'title': 'Previous', 'name': 'Internal', 'authentication': 'none'}
        with tempfile.TemporaryDirectory() as temp:
            backup = Path(temp) / 'before.json'
            rollback_backup = Path(temp) / 'before-restore.json'

            def request(endpoint, token, patch_data=None):
                self.assertEqual(endpoint, f'{origin}/api/v3/flows/instances/{slug}/')
                if patch_data is not None:
                    self.assertEqual(list(patch_data), ['title'])
                    self.assertTrue(backup.is_file())
                    current.update(patch_data)
                return dict(current)

            with patch.object(brand, 'request', side_effect=request) as api, patch.object(brand, 'emit'):
                args = (origin, slug, flow_id, 'en', 'fixture-token')
                brand.change_flow(*args, False)
                api.assert_called_once()
                brand.change_flow(*args, True, backup)
                self.assertEqual(stat.S_IMODE(backup.stat().st_mode), 0o600)
                self.assertEqual(current['title'], brand.messages('en')['portal.signInTitle'])
                brand.change_flow(*args, True, backup)
                brand.change_flow(*args, True, rollback_backup, backup)
                self.assertEqual(current['title'], 'Previous')
                self.assertEqual(current['name'], 'Internal')
                with self.assertRaises(brand.DeployError):
                    brand.change_flow(origin, slug, 'different', 'en', 'fixture-token', True)
                self.assertEqual(current['title'], 'Previous')
