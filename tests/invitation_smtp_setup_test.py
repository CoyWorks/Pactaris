import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('smtp_setup', Path(__file__).parents[1] / 'scripts/setup-invitation-smtp.py')
smtp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smtp)


class SetupTest(unittest.TestCase):
    def test_initial_setup_preserves_configuration_and_key_on_retry(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory) / 'gateway'
            (base / 'data').mkdir(parents=True)
            original = {'publicOrigin': 'https://example.invalid', 'session': {'idleSeconds': 1800}}
            (base / 'config.json').write_text(json.dumps(original))
            with patch.object(smtp.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=1)), patch.object(smtp.os, 'chown'):
                smtp.setup(base, 'sender@example.invalid', 'test$secret')
                mail = json.loads((base / 'data/invitation-mail.json').read_text())
                self.assertEqual(mail['password'], 'test$secret')
                self.assertEqual(len(mail['encryptionKey']), 64)
                self.assertEqual(mail['tls'], 'implicit')
                self.assertEqual(json.loads((base / 'config.json.before-invitation-smtp').read_text()), original)
                self.assertEqual(json.loads((base / 'config.json').read_text())['session'], original['session'])
                self.assertEqual((base / 'data/invitation-mail.json').stat().st_mode & 0o777, 0o640)
                with self.assertRaises(ValueError):
                    smtp.setup(base, 'sender@example.invalid', 'different')
                self.assertEqual(json.loads((base / 'data/invitation-mail.json').read_text()), mail)

    def test_existing_config_reference_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            (base / 'data').mkdir()
            (base / 'config.json').write_text('{"invitationMailFile":"/existing"}')
            with self.assertRaises(ValueError):
                smtp.setup(base, 'sender@example.invalid', 'password')
            self.assertFalse((base / 'data/invitation-mail.json').exists())


if __name__ == '__main__':
    unittest.main()
