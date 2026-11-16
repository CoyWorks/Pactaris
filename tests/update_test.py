import argparse
import importlib.util
import io
import json
import os
import fcntl
import signal
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
import update
import deploy

OLD = 'a' * 40
NEW = 'b' * 40
original_stat = Path.stat

def root_stat(path, *args, **kwargs):
    values = list(original_stat(path, *args, **kwargs))
    values[4] = 0
    return os.stat_result(values)

class UpdateTests(unittest.TestCase):
    def fixture(self, root, components=('gateway', 'instance', 'identity'), current=OLD):
        source = root / 'download'
        (source / 'apps/identity').mkdir(parents=True)
        (source / 'apps/identity/compose.yaml').write_text('services:\n  server:\n    image: provider:pinned\n')
        (source / 'deploy').mkdir()
        (source / 'deploy/release.json').write_text(json.dumps({'protocol': 2, 'migrations': []}))
        for name in components:
            base = root / name
            release = base / 'releases' / current
            release.mkdir(parents=True)
            (base / 'state.json').write_text(json.dumps({'revision': current, 'release': str(release)}))
            (base / 'config.json').write_text('{}')
            if name == 'identity':
                (release / 'apps/identity').mkdir(parents=True)
                (release / 'apps/identity/compose.yaml').write_text((source / 'apps/identity/compose.yaml').read_text())
        return source

    def args(self, root, **changes):
        values = dict(root=str(root), component=None, revision=NEW, repository=update.DEFAULT_REPOSITORY, check=False)
        return argparse.Namespace(**(values | changes))

    def execute(self, root, source, **changes):
        with patch.object(update, 'run', return_value=NEW), patch.object(update, 'safe_root', side_effect=Path), patch.object(update, 'validate_config', side_effect=lambda name, cfg: cfg), patch.object(update, 'preflight'), patch.object(Path, 'stat', root_stat), patch.object(update, 'child') as child, patch('sys.stdout', new_callable=io.StringIO):
            update.execute(self.args(root, **changes), source)
            return [call.args[0] for call in child.call_args_list]

    def test_all_installed_components_share_one_revision_and_identity_is_not_restarted(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = self.fixture(root)
            commands = self.execute(root, source)
            applies = [command for command in commands if '--apply' in command]
            self.assertEqual([command[command.index('--component') + 1] for command in applies], ['gateway', 'instance'])
            self.assertTrue(all(command[command.index('--revision') + 1] == NEW for command in applies))
            self.assertTrue(all(str(source / 'scripts/deploy.py') in command for command in commands))
            self.assertTrue(any('status' in command and 'identity' in command for command in commands))

    def test_current_release_is_a_health_only_noop_not_a_rebuild(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = self.fixture(root, current=NEW)
            commands = self.execute(root, source)
            self.assertEqual(len(commands), 3)
            self.assertTrue(all('status' in command for command in commands))

    def test_check_never_applies_or_restarts_and_single_component_remains_independent(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = self.fixture(root)
            commands = self.execute(root, source, check=True, component='instance')
            self.assertEqual(len(commands), 1)
            self.assertIn('instance', commands[0])
            self.assertNotIn('--apply', commands[0])

    def test_provider_image_change_blocks_every_apply_before_the_first_update(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = self.fixture(root)
            (source / 'apps/identity/compose.yaml').write_text('services:\n  server:\n    image: provider:changed\n')
            with patch.object(update, 'run', return_value=NEW), patch.object(update, 'safe_root', side_effect=Path), patch.object(update, 'validate_config', side_effect=lambda name, cfg: cfg), patch.object(update, 'preflight'), patch.object(Path, 'stat', root_stat), patch.object(update, 'child') as child, patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaises(deploy.DeployError) as error:
                    update.execute(self.args(root), source)
                self.assertEqual(error.exception.key, 'cli.updateIdentityReview')
                self.assertFalse(any('--apply' in call.args[0] for call in child.call_args_list))

    def test_failure_stops_later_component_updates(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source = self.fixture(root)
            applied = []
            def child(command):
                if '--apply' in command:
                    applied.append(command[command.index('--component') + 1])
                    raise deploy.DeployError('cli.updateStopped', code=1)
            with patch.object(update, 'run', return_value=NEW), patch.object(update, 'safe_root', side_effect=Path), patch.object(update, 'validate_config', side_effect=lambda name, cfg: cfg), patch.object(update, 'preflight'), patch.object(Path, 'stat', root_stat), patch.object(update, 'child', side_effect=child), patch('sys.stdout', new_callable=io.StringIO):
                with self.assertRaises(deploy.DeployError):
                    update.execute(self.args(root), source)
            self.assertEqual(applied, ['gateway'])

    def test_incomplete_install_and_unsafe_state_are_not_silently_skipped(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root, components=('gateway',))
            (root / 'instance').mkdir()
            (root / 'instance/config.json').write_text('{}')
            with patch.object(update, 'safe_root', side_effect=Path), patch.object(Path, 'stat', root_stat):
                with self.assertRaises(deploy.DeployError):
                    update.installed(root)
                (root / 'gateway/state.json').chmod(0o666)
                with self.assertRaises(deploy.DeployError):
                    update.installed(root, 'gateway')

    def test_bootstrap_fetches_once_and_hands_off_to_downloaded_updater(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            self.fixture(root, components=('instance',))
            commands = []
            def run(command):
                commands.append(command)
                if command[1] == 'init':
                    staged = Path(command[-1]); (staged / 'scripts').mkdir(parents=True)
                    (staged / 'scripts/update.py').write_text('# fixture')
                return NEW if command[-1] == 'FETCH_HEAD' else ''
            def check_lock(command):
                with open(root / 'update.lock', 'a') as handle:
                    with self.assertRaises(BlockingIOError):
                        fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(update.os, 'geteuid', return_value=0), patch.object(update, 'safe_root', side_effect=Path), patch.object(Path, 'stat', root_stat), patch.object(update, 'run', side_effect=run), patch.object(update, 'child', side_effect=check_lock) as child, patch('sys.stdout', new_callable=io.StringIO):
                self.assertEqual(update.main(['--root', str(root)]), 0)
                handoff = child.call_args.args[0]
            self.assertEqual(sum('fetch' in command for command in commands), 1)
            self.assertTrue(any('refs/heads/main' in command for command in commands))
            self.assertIn('--staged-source', handoff)
            self.assertIn(NEW, handoff)
            self.assertNotIn('--check', handoff)

    def test_cancellation_stops_the_child_group_before_returning(self):
        with patch.object(update.subprocess, 'Popen') as popen, patch.object(update.os, 'killpg') as kill:
            process = popen.return_value.__enter__.return_value
            process.pid = 321
            process.poll.return_value = None
            process.wait.side_effect = [KeyboardInterrupt(), 0]
            with self.assertRaises(KeyboardInterrupt):
                update.child(['python3', 'fixture-updater.py'])
            kill.assert_called_once_with(321, signal.SIGINT)
            self.assertTrue(popen.call_args.kwargs['start_new_session'])

    def test_non_root_and_credential_bearing_source_fail_without_fetching(self):
        with patch.object(update.os, 'geteuid', return_value=1000), patch.object(update, 'run') as run, patch('sys.stdout', new_callable=io.StringIO):
            self.assertEqual(update.main([]), 1)
            run.assert_not_called()
        with patch.object(update.os, 'geteuid', return_value=0), patch.object(update, 'safe_root', side_effect=Path), patch.object(update, 'run') as run, patch('sys.stdout', new_callable=io.StringIO) as output:
            self.assertEqual(update.main(['--repository', 'https://secret@github.com/CoyWorks/Pactaris.git']), 1)
            run.assert_not_called()
            self.assertNotIn('secret', output.getvalue())

    def test_inactive_failed_release_is_archived_but_active_release_is_never_moved(self):
        with tempfile.TemporaryDirectory() as folder:
            base = Path(folder)
            current = base / 'releases' / OLD; current.mkdir(parents=True)
            staged = base / 'releases' / NEW; staged.mkdir()
            (staged / 'build.log').write_text('preserve diagnostics')
            (base / 'data').mkdir(); (base / 'data/keep').write_text('preserve data')
            (base / 'current').symlink_to(current)
            state = {'release': str(current)}
            with patch.object(deploy, 'safe_root', side_effect=Path), patch.object(deploy.shutil, 'chown'), patch('sys.stdout', new_callable=io.StringIO):
                deploy.archive_staged_update(base, staged, state)
                with self.assertRaises(deploy.DeployError):
                    deploy.archive_staged_update(base, current, state)
            saved = list((base / 'failed-releases').iterdir())
            self.assertEqual((saved[0] / 'build.log').read_text(), 'preserve diagnostics')
            self.assertEqual((base / 'data/keep').read_text(), 'preserve data')
            self.assertEqual((base / 'current').resolve(), current)

    def test_help_works_without_root_and_explains_the_new_default(self):
        result = subprocess.run(['bash', 'update.sh', '--help'], cwd=Path(__file__).parents[1], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn('applying is now the default', result.stdout)

    def test_local_registration_uses_shared_ca_preserves_config_and_check_is_read_only(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder)
            for name in ('gateway','instance'):
                (root/name).mkdir()
                (root/name/'ca.crt').write_text('fixture-ca')
                (root/name/'config.json').write_text(json.dumps({'listen':{'tls':{'caFile':str(root/name/'ca.crt')}},'delegation':{'fixture':True}}))
            before={name:(root/name/'config.json').read_bytes() for name in ('gateway','instance')}
            with patch.object(update,'child') as child,patch('sys.stdout',new_callable=io.StringIO):
                update.register_local_instance(root,True,{'gateway','instance','identity'})
                child.assert_not_called()
                update.register_local_instance(root,False,{'gateway','instance','identity'})
                self.assertEqual(child.call_count,1)
                command=child.call_args.args[0]
                self.assertIn('--apply',command)
                self.assertIn('INSTANCE_CONFIG='+str(root/'instance/config.json'),command)
                self.assertFalse(any('identity' in value for value in command))
                (root/'instance/ca.crt').write_text('separate-ca')
                update.register_local_instance(root,False,{'gateway','instance'})
                self.assertEqual(child.call_count,1)
            self.assertEqual(before,{name:(root/name/'config.json').read_bytes() for name in ('gateway','instance')})

if __name__ == '__main__':
    unittest.main()
