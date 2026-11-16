import importlib.util
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('deploy', Path(__file__).parents[1]/'scripts/deploy.py')
deploy = importlib.util.module_from_spec(spec); spec.loader.exec_module(deploy)
sys.modules['deploy'] = deploy
spec = importlib.util.spec_from_file_location('prepare_login', Path(__file__).parents[1]/'scripts/prepare-login.py')
prepare = importlib.util.module_from_spec(spec); spec.loader.exec_module(prepare)

class LoginPreparationTests(unittest.TestCase):
    def test_psql_uses_machine_output_and_sql_credentials_never_enter_arguments(self):
        result = subprocess.CompletedProcess([], 0, stdout='[false,false,false,true,false]\n', stderr='')
        with patch.object(prepare.subprocess, 'run', return_value=result) as run:
            self.assertEqual(prepare.psql("SELECT 'fixture-secret'"), '[false,false,false,true,false]')
        args = run.call_args.args[0]
        self.assertIn('-t', args); self.assertIn('-A', args)
        self.assertNotIn('fixture-secret', ' '.join(args))
        self.assertIn('fixture-secret', run.call_args.kwargs['input'])

    def test_database_identifiers_cannot_inject_sql(self):
        for name in ['x;DROP DATABASE postgres', 'x"', 'x\n', 'postgres.role']:
            with self.assertRaises(deploy.DeployError): prepare.identifier(name)

    def test_existing_role_without_its_preserved_credential_is_not_overwritten(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder, patch.object(prepare, 'psql', return_value='1') as query:
            with self.assertRaises(deploy.DeployError):
                prepare.provision_role(Path(folder),'fixture_role','fixture_database')
            self.assertEqual(query.call_count,1)
            self.assertEqual(list(Path(folder).iterdir()),[])
