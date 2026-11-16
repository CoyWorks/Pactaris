import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1] / 'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)

class DeploymentTests(unittest.TestCase):
    def identity(self):
        return {'publicOrigin': 'https://identity.test.invalid', 'listen': {'address': '127.0.0.1', 'port': 9443}, 'locale': {'language': 'en'}}

    def test_plan_is_read_only_and_never_runs_child_commands(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder) / 'not-created'
            config = Path(folder) / 'source.json'
            config.write_text(json.dumps(self.identity()))
            with patch.object(deploy, 'run', side_effect=AssertionError('no command allowed')), patch('sys.stdout', new_callable=io.StringIO) as output:
                code = deploy.main(['install', '--component', 'identity', '--root', str(root), '--config', str(config), '--revision', 'a' * 40])
            self.assertEqual(code, 0)
            self.assertFalse(root.exists())
            self.assertEqual(json.loads(output.getvalue())['messageKey'], 'cli.plan')

    def test_invalid_revision_and_credential_bearing_repository_are_rejected(self):
        for value in ['https://token@github.com/owner/repo.git', 'https://github.com/owner/repo.git?token=secret', 'file:///tmp/repo', 'https://attacker.invalid/repo.git']:
            with self.assertRaises(deploy.DeployError):
                deploy.repository(value)
        with self.assertRaises(deploy.DeployError):
            deploy.validate_config('identity', {**self.identity(), 'publicOrigin': 'https://user:secret@host.invalid'})

    def test_paths_for_privileged_writes_cannot_contain_shell_or_systemd_expansions(self):
        for path in ['/', 'relative', '/opt/a/../b', '/opt/%n', '/opt/a\nb', '/opt/$(id)', '/opt/a b']:
            with self.assertRaises(deploy.DeployError):
                deploy.safe_root(path)

    def test_update_preserves_config_and_uses_independent_lock_names(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / 'identity'
            base.mkdir()
            (base / 'state.json').write_text(json.dumps({'revision': 'a' * 40, 'release': '/previous'}))
            config = base / 'config.json'
            config.write_text(json.dumps(self.identity()))
            original = config.read_bytes()
            with patch('sys.stdout', new_callable=io.StringIO):
                code = deploy.main(['update', '--component', 'identity', '--root', folder, '--config', '/replacement.json', '--revision', 'b' * 40])
            self.assertEqual(code, 1)
            self.assertEqual(config.read_bytes(), original)
            identity = deploy.compose(base, Path('/release'))
            other = deploy.compose(Path(folder) / 'instance', Path('/release'))
            self.assertNotEqual(identity[3], other[3])

    def test_atomic_release_link_switch_preserves_data_and_previous_release(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            first, second = base / 'first', base / 'second'
            first.mkdir(); second.mkdir()
            data = base / 'persistent.json'; data.write_text('{"preserve":true}')
            deploy.activate_link(base, first)
            deploy.activate_link(base, second)
            self.assertEqual((base / 'current').resolve(), second)
            deploy.activate_link(base, first)
            self.assertEqual((base / 'current').resolve(), first)
            self.assertEqual(data.read_text(), '{"preserve":true}')
            self.assertTrue(second.exists())

    def test_service_units_do_not_execute_a_shell_or_share_component_configuration(self):
        unit = deploy.render_unit(Path('/opt/the-app/instance'), '/usr/bin/node')
        worker = deploy.render_unit(Path('/opt/the-app/instance'), '/usr/bin/node', worker=True)
        self.assertIn('User=cwa-instance-', unit)
        self.assertIn('ProtectSystem=strict', unit)
        self.assertNotIn('/bin/sh', unit)
        self.assertIn('apps/instance/worker.js', worker)
        self.assertNotIn('/identity/', unit)
        self.assertNotEqual(deploy.service_identity(Path('/opt/a/instance')), deploy.service_identity(Path('/opt/b/instance')))

if __name__ == '__main__':
    unittest.main()
