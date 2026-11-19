import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).parents[1] / 'scripts'))
import offsite_backup

RECIPIENT = 'age1' + 'q' * 58
original_lstat = Path.lstat


def root_lstat(path, *args, **kwargs):
    values = list(original_lstat(path, *args, **kwargs))
    values[4] = 0
    return os.stat_result(values)


class OffsiteBackupTests(unittest.TestCase):
    def config(self, folder, **changes):
        path = Path(folder) / 'offsite.json'
        value = {'recipient': RECIPIENT, 'target': {'type': 'directory', 'path': str(Path(folder) / 'target')}, 'keep': 2} | changes
        path.write_text(json.dumps(value))
        path.chmod(0o600)
        return path

    def load(self, path):
        with patch.object(Path, 'lstat', root_lstat):
            return offsite_backup.load_config(path)

    def install(self, folder, components=('instance', 'gateway')):
        root = Path(folder) / 'opt'
        release = root / 'gateway/current'
        (release / 'scripts').mkdir(parents=True)
        (release / 'backup.sh').write_text('')
        (release / 'scripts/encrypt_checkpoint.py').write_text('')
        for component in components:
            (root / component).mkdir(parents=True, exist_ok=True)
            (root / component / 'state.json').write_text('{}')
        return root

    def fake_run(self, root, fail=()):
        counter = iter(range(10**18, 10**18 + 1000))
        def run(command):
            if command[1].endswith('backup.sh'):
                component = command[command.index('--component') + 1]
                if component in fail:
                    return subprocess.CompletedProcess(command, 1, '', '')
                path = root / component / 'backups' / str(next(counter))
                path.mkdir(parents=True)
                line = json.dumps({'messageKey': 'cli.backupComplete', 'component': component, 'path': str(path)})
                return subprocess.CompletedProcess(command, 0, '{"messageKey":"cli.command"}\n' + line + '\n', '')
            output = Path(command[command.index('--output') + 1])
            self.assertEqual(command[command.index('--recipient') + 1], RECIPIENT)
            output.write_bytes(b'age-encrypted fixture')
            return subprocess.CompletedProcess(command, 0, '', '')
        return run

    def test_not_configured_is_a_harmless_noop(self):
        with tempfile.TemporaryDirectory() as folder, patch('sys.stdout', new_callable=io.StringIO) as out:
            self.assertEqual(offsite_backup.main(['--config', str(Path(folder) / 'missing.json')]), 0)
            self.assertIn('offsite.not_configured', out.getvalue())

    def test_directory_target_publishes_complete_archives_and_keeps_the_newest(self):
        with tempfile.TemporaryDirectory() as folder:
            root, state = self.install(folder), Path(folder) / 'state'
            cfg = self.load(self.config(folder))
            with patch.object(offsite_backup, 'run', side_effect=self.fake_run(root)), patch('sys.stdout', new_callable=io.StringIO):
                for _ in range(3):
                    self.assertEqual(offsite_backup.backup(cfg, root, state), 0)
            for component in ('instance', 'gateway'):
                archives = sorted((Path(folder) / 'target' / component).iterdir())
                self.assertEqual(len(archives), 2)
                self.assertTrue(all(offsite_backup.ARCHIVE.fullmatch(a.name) and a.read_bytes() == b'age-encrypted fixture' for a in archives))
            self.assertFalse((Path(folder) / 'target/identity').exists())
            self.assertEqual(list((state / 'staging').iterdir()), [])
            recorded = json.loads((state / 'state.json').read_text())
            self.assertIn('lastSuccessAt', recorded['instance'])

    def test_one_failed_component_is_reported_without_stopping_the_others(self):
        with tempfile.TemporaryDirectory() as folder:
            root, state = self.install(folder), Path(folder) / 'state'
            cfg = self.load(self.config(folder))
            with patch.object(offsite_backup, 'run', side_effect=self.fake_run(root, fail=('instance',))), patch('sys.stdout', new_callable=io.StringIO) as out:
                self.assertEqual(offsite_backup.backup(cfg, root, state), 1)
            self.assertIn('offsite.checkpoint_failed', out.getvalue())
            self.assertEqual(len(list((Path(folder) / 'target/gateway').iterdir())), 1)
            recorded = json.loads((state / 'state.json').read_text())
            self.assertIn('lastFailureAt', recorded['instance'])
            self.assertNotIn('lastSuccessAt', recorded['instance'])

    def test_configuration_rejects_unsafe_values(self):
        with tempfile.TemporaryDirectory() as folder:
            ssh = {'type': 'ssh', 'path': '/srv/pactaris', 'host': 'backup.example.org', 'user': 'pactaris',
                   'identityFile': '/root/.ssh/pactaris_backup', 'knownHostsFile': '/root/.ssh/known_hosts_backup'}
            self.assertEqual(self.load(self.config(folder, target=ssh))['target']['port'], 22)
            bad = [{'recipient': 'age1short'}, {'keep': 0}, {'components': ['instance', 'instance']}, {'extra': True},
                   {'target': {'type': 'directory', 'path': 'relative'}}, {'target': {'type': 'directory', 'path': '/srv/../etc'}},
                   {'target': {'type': 'directory', 'path': '/srv/a b'}}, {'target': {'type': 's3', 'path': '/x'}},
                   {'target': ssh | {'host': '-oProxyCommand=x'}}, {'target': ssh | {'path': '/srv/$(id)'}},
                   {'target': ssh | {'user': 'root;id'}}, {'target': ssh | {'port': 0}}]
            for changes in bad:
                with self.assertRaises(offsite_backup.BackupError):
                    self.load(self.config(folder, **changes))
            path = self.config(folder)
            path.chmod(0o644)
            with self.assertRaises(offsite_backup.BackupError):
                self.load(path)

    def test_ssh_target_uses_strict_host_keys_and_a_temporary_name(self):
        target = {'type': 'ssh', 'path': '/srv/pactaris', 'host': 'backup.example.org', 'user': 'pactaris', 'port': 2222,
                  'identityFile': '/root/.ssh/pactaris_backup', 'knownHostsFile': '/root/.ssh/known_hosts_backup'}
        calls = []
        with patch.object(offsite_backup, 'run', side_effect=lambda command: calls.append(command) or subprocess.CompletedProcess(command, 0, '', '')):
            offsite_backup.publish(Path('/tmp/instance-20261119T024700Z-1000000000000000000.tar.age'), target, 'instance')
        self.assertTrue(all('StrictHostKeyChecking=yes' in call and 'BatchMode=yes' in call for call in calls))
        self.assertTrue(calls[1][-1].endswith(':/srv/pactaris/instance/.partial-instance-20261119T024700Z-1000000000000000000.tar.age'))
        self.assertIn('mv -n -- /srv/pactaris/instance/.partial-', calls[2][-1])


if __name__ == '__main__':
    unittest.main()
