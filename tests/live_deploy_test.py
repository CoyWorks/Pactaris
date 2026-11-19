import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch


spec = importlib.util.spec_from_file_location(
    'live_deploy', Path(__file__).resolve().parents[1] / 'scripts/live_deploy.py')
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)
REVISION = 'a' * 40


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.github = Mock()
        self.github.head.return_value = REVISION
        self.github.approved.return_value = True
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.state = self.root / 'poller.json'
        self.updater = self.root / 'update.sh'
        for component in deploy.COMPONENTS:
            (self.root / component).mkdir()
            (self.root / component / 'state.json').write_text(json.dumps({'revision': REVISION}))

    def reconcile(self, mode='apply'):
        return deploy.reconcile(self.github, mode, self.root, self.updater, self.state)

    def test_wrong_branch_or_failed_ci_does_not_run_updater(self):
        with patch.object(deploy.subprocess, 'run') as run:
            self.github.approved.return_value = False
            self.assertEqual(self.reconcile(), 0)
            self.github.approved.return_value = True
            self.github.head.side_effect = [REVISION, 'b' * 40]
            self.assertEqual(self.reconcile(), 0)
            run.assert_not_called()
            self.github.status.assert_not_called()

    def test_plan_then_apply_uses_same_pin_and_does_not_replay(self):
        with patch.object(deploy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            self.assertEqual(self.reconcile('plan'), 0)
            self.assertEqual(self.reconcile('plan'), 0)
            self.assertEqual(self.reconcile('apply'), 0)
            self.assertEqual(self.reconcile('apply'), 0)
            self.assertEqual(run.call_count, 2)
            plan, apply = [call.args[0] for call in run.call_args_list]
            self.assertEqual(plan, apply + ['--check'])
            self.assertEqual(apply[-2:], ['--revision', REVISION])
            self.github.status.assert_called_with(REVISION, 'apply', 'success', 'Updater and health checks passed')

    def test_interrupted_or_failed_activation_is_not_retried(self):
        with patch.object(deploy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertEqual(self.reconcile(), 1)
            self.github.head.return_value = 'b' * 40
            self.assertEqual(self.reconcile(), 1)
            self.assertEqual(run.call_count, 1)
            self.state.write_text(json.dumps({'mode': 'apply', 'revision': REVISION, 'phase': 'running'}))
            self.assertEqual(self.reconcile(), 1)
            self.assertEqual(run.call_count, 1)
            self.github.status.assert_called_with(REVISION, 'apply', 'failure', 'Interrupted; check host journal')

    def test_unreported_success_retries_publication_without_deploying_again(self):
        self.github.status.side_effect = [None, OSError(), None]
        with patch.object(deploy.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as run:
            with self.assertRaises(OSError):
                self.reconcile()
            self.assertEqual(self.reconcile(), 0)
            self.assertEqual(run.call_count, 1)
            self.assertEqual(json.loads(self.state.read_text())['phase'], 'done')

    def test_requires_exact_successful_main_push_from_ci_workflow(self):
        github = deploy.GitHub('fixture_token')
        main = 'b' * 40
        compare = {'status': 'ahead', 'merge_base_commit': {'sha': REVISION}}
        run = {'head_sha': REVISION, 'head_branch': 'main', 'event': 'push',
               'status': 'completed', 'conclusion': 'success'}
        with patch.object(github, 'head', return_value=main), patch.object(github, 'request') as request:
            request.side_effect = [compare, {'workflow_runs': [run]}]
            self.assertTrue(github.approved(REVISION))
            self.assertTrue(request.call_args.args[0].startswith('/actions/workflows/ci.yml/runs?head_sha='))
            request.side_effect = [compare, {'workflow_runs': [{**run, 'event': 'pull_request'}]}]
            self.assertFalse(github.approved(REVISION))
            request.side_effect = [{**compare, 'status': 'diverged'}]
            self.assertFalse(github.approved(REVISION))
