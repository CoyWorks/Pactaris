import importlib.util
import io
import json
import os
import subprocess
import sys
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
        unit = deploy.render_unit(Path('/opt/pactaris/instance'), '/usr/bin/node')
        worker = deploy.render_unit(Path('/opt/pactaris/instance'), '/usr/bin/node', worker=True)
        self.assertIn('User=pactaris-instance-', unit)
        self.assertIn('ProtectSystem=strict', unit)
        self.assertNotIn('/bin/sh', unit)
        self.assertIn('apps/instance/worker.js', worker)
        self.assertNotIn('/identity/', unit)
        self.assertNotEqual(deploy.service_identity(Path('/opt/a/instance')), deploy.service_identity(Path('/opt/b/instance')))

    def test_command_progress_does_not_expose_arguments_or_child_output(self):
        with patch('sys.stdout', new_callable=io.StringIO) as output:
            result = deploy.run([sys.executable, '-c', 'print("private-database-url")'])
        self.assertEqual(result, 'private-database-url')
        self.assertNotIn('private-database-url', output.getvalue())
        self.assertEqual(json.loads(output.getvalue())['messageKey'], 'cli.command')

    def test_private_bootstrap_umask_does_not_block_service_directory_traversal(self):
        with tempfile.TemporaryDirectory() as folder:
            previous = os.umask(0o077)
            try:
                root = Path(folder) / 'pactaris'
                base = root / 'instance'
                for path in (root, base, base / 'releases'):
                    deploy.deployment_directory(path)
                    self.assertEqual(path.stat().st_mode & 0o777, 0o755)
            finally:
                os.umask(previous)

    def test_slow_commands_report_waiting_without_exposing_credentials(self):
        with patch.object(deploy.subprocess, 'Popen') as process, patch('sys.stdout', new_callable=io.StringIO) as output:
            child = process.return_value.__enter__.return_value
            child.communicate.side_effect = [subprocess.TimeoutExpired('private-argument', 15), (b'private-output', b'')]
            child.returncode = 0
            result = deploy.run(['npm', 'private-argument'])
        self.assertEqual(result, 'private-output')
        self.assertIn('cli.waiting', output.getvalue())
        self.assertNotIn('private-', output.getvalue())

    def test_cancellation_terminates_the_child_process_group(self):
        with patch.object(deploy.subprocess, 'Popen') as process, patch.object(deploy.os, 'killpg') as kill, patch('sys.stdout', new_callable=io.StringIO):
            child = process.return_value.__enter__.return_value
            child.pid = 12345
            child.poll.return_value = None
            child.communicate.side_effect = [KeyboardInterrupt(), (b'', b'')]
            with self.assertRaises(KeyboardInterrupt):
                deploy.run(['npm', 'ci'])
            kill.assert_called_once_with(12345, deploy.signal.SIGTERM)

    def test_identity_resume_preserves_secrets_and_only_records_success_after_health(self):
        for healthy in (True, False):
            with self.subTest(healthy=healthy), tempfile.TemporaryDirectory() as folder:
                base = Path(folder) / 'identity'
                revision = 'a' * 40
                release = base / 'releases' / revision
                (release / '.git').mkdir(parents=True)
                (release / 'deploy').mkdir()
                (release / 'deploy/release.json').write_text(json.dumps({'version': 'test', 'protocol': 1, 'migrations': []}))
                config = base / 'config.json'
                config.write_text(json.dumps(self.identity()))
                secret = base / 'identity.env'; secret.write_text('PG_PASS=preserve-secret\n')
                original = config.read_bytes(), secret.read_bytes()
                deploy.activate_link(base, release)
                def fake_run(args, **kwargs):
                    return revision if args[-2:] == ['rev-parse', 'HEAD'] else ''
                with patch.object(deploy, 'run', side_effect=fake_run) as run, patch.object(deploy, 'safe_root', side_effect=Path), patch.object(deploy, 'preflight'), patch.object(deploy, 'health', side_effect=None if healthy else RuntimeError('unhealthy')), patch.object(deploy.time, 'sleep'), patch('sys.stdout', new_callable=io.StringIO):
                    code = deploy.main(['resume', '--component', 'identity', '--root', folder, '--revision', revision, '--apply'])
                self.assertEqual(code, 0 if healthy else 1)
                self.assertEqual(original, (config.read_bytes(), secret.read_bytes()))
                self.assertEqual((base / 'state.json').exists(), healthy)
                self.assertEqual((base / 'current').resolve(), release)
                commands = [call.args[0] for call in run.call_args_list]
                self.assertFalse(any('clone' in command or 'pull' in command for command in commands))

    def test_resume_refuses_other_releases_missing_secrets_and_completed_installs(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / 'identity'
            release = base / 'releases' / ('a' * 40)
            (release / '.git').mkdir(parents=True)
            with self.assertRaises(deploy.DeployError):
                deploy.validate_resume(base, release)
            (base / 'config.json').write_text('{}')
            (base / 'identity.env').write_text('preserve')
            deploy.validate_resume(base, release)
            deploy.activate_link(base, base / 'releases' / ('b' * 40))
            with self.assertRaises(deploy.DeployError):
                deploy.validate_resume(base, release)
            (base / 'current').unlink()
            (base / 'state.json').write_text('{}')
            with self.assertRaises(deploy.DeployError):
                deploy.validate_resume(base, release)

    def test_database_uri_is_split_and_password_file_is_private_and_temporary(self):
        with tempfile.TemporaryDirectory() as folder, patch.dict(os.environ, {'PGUSER': 'wrong', 'PGPASSWORD': 'ambient-secret', 'PGSERVICE': 'wrong'}):
            url = 'postgresql://fixture%20user:p%3Aa%5Css@127.0.0.1:5544/fixture%20db?sslmode=verify-full&sslrootcert=%2Fprivate%2Fca.crt'
            with deploy.postgres_environment(url, folder) as env:
                self.assertEqual(env['PGDATABASE'], 'fixture db')
                self.assertEqual(env['PGUSER'], 'fixture user')
                self.assertEqual(env['PGPORT'], '5544')
                self.assertEqual(env['PGHOST'], '127.0.0.1')
                self.assertEqual(env['PGSSLMODE'], 'verify-full')
                self.assertEqual(env['PGSSLROOTCERT'], '/private/ca.crt')
                self.assertNotIn('PGPASSWORD', env)
                self.assertNotIn('PGSERVICE', env)
                password_file = Path(env['PGPASSFILE'])
                self.assertEqual(password_file.stat().st_mode & 0o777, 0o600)
                self.assertEqual(password_file.read_text(), '127.0.0.1:5544:fixture db:fixture user:p\\:a\\\\ss\n')
            self.assertFalse(password_file.exists())

    def test_failed_dump_retains_partial_only_and_removes_temporary_password(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder) / 'instance'; base.mkdir()
            (base / 'config.json').write_text('{}')
            cfg = {'database': {'url': 'postgresql://runtime:secret@127.0.0.1:5432/fixture'}}
            def fail_dump(args, **kwargs):
                self.assertIn('--no-password', args)
                self.assertEqual(kwargs['env']['PGDATABASE'], 'fixture')
                self.assertEqual(kwargs['env']['PGUSER'], 'runtime')
                self.assertFalse(any('secret' in arg for arg in args))
                kwargs['output'].write(b'incomplete dump')
                kwargs['output'].flush()
                self.assertTrue(Path(kwargs['env']['PGPASSFILE']).exists())
                raise deploy.DeployError('cli.commandFailed', tool='pg_dump', code=1)
            with patch.object(deploy, 'run', side_effect=fail_dump), self.assertRaises(deploy.DeployError):
                deploy.checkpoint(base, cfg, None)
            self.assertEqual(len(list(base.glob('backups/*/database.sql.partial'))), 1)
            self.assertEqual(list(base.glob('backups/*/database.sql')), [])
            self.assertEqual(list(base.glob('backups/*/pactaris-pg-*')), [])

    def test_command_failure_logs_stderr_privately_without_console_credentials(self):
        with tempfile.TemporaryDirectory() as folder, patch('sys.stdout', new_callable=io.StringIO) as output:
            log = Path(folder) / 'error.log'
            with self.assertRaises(deploy.DeployError):
                deploy.run([sys.executable, '-c', 'import sys;sys.stderr.write("fixture-secret");sys.exit(1)'], error_file=log)
            self.assertEqual(log.read_text(), 'fixture-secret')
            self.assertEqual(log.stat().st_mode & 0o777, 0o600)
            self.assertNotIn('fixture-secret', output.getvalue())

    def test_unknown_database_options_fail_instead_of_dropping_security_settings(self):
        with tempfile.TemporaryDirectory() as folder:
            with self.assertRaises(deploy.DeployError):
                with deploy.postgres_environment('postgresql://runtime:secret@127.0.0.1/fixture?unsupported_security_option=required', folder):
                    self.fail('unsupported option accepted')

class GatewayDeploymentTests(unittest.TestCase):
    def test_gateway_units_select_gateway_runtime_and_keep_a_separate_identity(self):
        unit = deploy.render_unit(Path('/opt/pactaris/gateway'), '/usr/bin/node')
        self.assertIn('/apps/gateway/server.js', unit)
        self.assertIn('User=pactaris-gateway-', unit)
        self.assertNotIn('/apps/instance/', unit)
        self.assertNotEqual(deploy.service_identity(Path('/opt/pactaris/gateway')), deploy.service_identity(Path('/opt/pactaris/instance')))

    def test_runtime_staging_copies_only_required_secrets_and_preserves_root_only_database_files(self):
        from types import SimpleNamespace
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); base = root / 'gateway'; base.mkdir()
            client = root / 'client.secret'; client.write_text('fixture-client-secret')
            key = root / 'private.key'; key.write_text('fixture-signing-key')
            migration = root / 'migration.url'; migration.write_text('fixture-migration-credential'); migration.chmod(0o600)
            cfg = {'oidc': {'clientSecretFile': str(client)}, 'delegation': {'privateKeyFile': str(key)}, 'database': {'migrationUrlFile': str(migration)}}
            info = SimpleNamespace(pw_gid=os.getgid())
            previous = os.umask(0o077)
            try:
                with patch.object(deploy, 'safe_root'), patch.object(deploy.shutil, 'chown'):
                    deploy.stage_runtime_secrets(base, cfg, info)
                self.assertEqual((base/'secrets').stat().st_mode & 0o777, 0o750)
                self.assertEqual(Path(cfg['oidc']['clientSecretFile']).stat().st_mode & 0o777, 0o640)
                self.assertEqual(Path(cfg['oidc']['clientSecretFile']).read_text(), 'fixture-client-secret')
                self.assertEqual(cfg['database']['migrationUrlFile'], str(migration))
                self.assertFalse((base/'secrets/migration.url').exists())
                self.assertEqual(migration.stat().st_mode & 0o777, 0o600)
            finally:
                os.umask(previous)

if __name__ == '__main__':
    unittest.main()
