from datetime import datetime, timedelta, timezone
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


scripts = Path(__file__).resolve().parents[1] / 'scripts'
spec = importlib.util.spec_from_file_location('monitor', scripts / 'monitor.py')
monitor = importlib.util.module_from_spec(spec)
with patch.object(sys, 'path', [str(scripts), *sys.path]):
    spec.loader.exec_module(monitor)


class MonitorTests(unittest.TestCase):
    def test_report_counts_completed_checkpoint_only_and_redacts_configuration(self):
        now = datetime.now(timezone.utc)
        with tempfile.TemporaryDirectory() as temp:
            base = Path(temp) / 'gateway'
            older = base / 'backups' / '1234567890000000001'
            recent = base / 'backups' / '1234567890000000002'
            older.mkdir(parents=True)
            recent.mkdir()
            (older / 'database.sql').write_bytes(b'a successful dump')
            (older / 'backup.completed.json').write_text(json.dumps({
                'component': 'gateway', 'scope': 'database-checkpoint',
                'completedAt': (now - timedelta(minutes=10)).isoformat(), 'bytes': 17,
            }))
            (recent / 'database.sql.partial').write_bytes(b'failed dump')
            (base / 'state.json').write_text(json.dumps({'release': '/fixture/private', 'revision': 'a' * 40}))
            (base / 'config.json').write_text('{}')
            heartbeat = base / 'worker.json'
            heartbeat.write_text(json.dumps({'checkedAt': now.isoformat()}))
            config = {'worker': {'heartbeatFile': str(heartbeat)}, 'database': {'url': 'fixture-secret'}}
            def fail_with_output(*args):
                print('fixture-secret')
                raise OSError('fixture-secret')
            with patch.object(monitor, 'validate_config', return_value=config), patch.object(monitor, 'health', side_effect=fail_with_output), patch('sys.stdout', new_callable=io.StringIO) as stdout:
                result = monitor.report(base)
            self.assertFalse(result['ready'])
            self.assertEqual(result['workerHeartbeatAgeSeconds'], 0)
            self.assertEqual(result['databaseCheckpointAgeSeconds'], 600)
            self.assertEqual(stdout.getvalue(), '')
            self.assertNotIn('fixture-secret', json.dumps(result))
            self.assertNotIn('/fixture/private', json.dumps(result))
