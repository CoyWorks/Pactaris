import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('branch_cleanup', Path(__file__).parents[1] / 'scripts/cleanup-merged-branches.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class BranchCleanupTests(unittest.TestCase):
    def fixtures(self, changed=False):
        def api(path, pages=False):
            if path == 'repos/CoyWorks/Pactaris': return {'default_branch': 'main'}
            if '/branches?' in path: return [[
                {'name': 'main', 'protected': False, 'commit': {'sha': 'm'}},
                {'name': 'feature/old', 'protected': False, 'commit': {'sha': 'a'}},
                {'name': 'feature/new', 'protected': False, 'commit': {'sha': 'b'}},
                {'name': 'feature/locked', 'protected': True, 'commit': {'sha': 'a'}},
                {'name': 'feature/current', 'protected': False, 'commit': {'sha': 'a'}}]]
            if '/compare/a...' in path: return {'status': 'ahead', 'behind_by': 0, 'merge_base_commit': {'sha': 'a'}}
            if '/compare/b...' in path: return {'status': 'diverged', 'behind_by': 2, 'merge_base_commit': {'sha': 'x'}}
            return {'object': {'sha': ('changed' if changed else 'a') if 'feature/old' in path else 'm'}}
        return api
    def command(self, argv, optional=False):
        return SimpleNamespace(returncode=0, stdout='feature/current\n' if 'symbolic-ref' in argv else '')
    def test_plan_never_pushes_and_excludes_unmerged_protected_current(self):
        with patch.object(module, 'api', side_effect=self.fixtures()), patch.object(module, 'run', side_effect=self.command) as run, patch.object(module, 'emit'):
            self.assertEqual(module.cleanup('CoyWorks/Pactaris'), (1, 0))
            self.assertFalse(any('push' in call.args[0] for call in run.call_args_list))
    def test_apply_uses_exact_server_side_lease_without_credentials(self):
        with patch.object(module, 'api', side_effect=self.fixtures()), patch.object(module, 'run', side_effect=self.command) as run, patch.object(module, 'emit'):
            self.assertEqual(module.cleanup('CoyWorks/Pactaris', True), (1, 1))
            command = next(c.args[0] for c in run.call_args_list if 'push' in c.args[0])
            self.assertIn('--force-with-lease=refs/heads/feature/old:a', command)
            self.assertEqual(command[-1], ':refs/heads/feature/old')
    def test_changed_branch_is_skipped(self):
        with patch.object(module, 'api', side_effect=self.fixtures(True)), patch.object(module, 'run', side_effect=self.command) as run, patch.object(module, 'emit'):
            self.assertEqual(module.cleanup('CoyWorks/Pactaris', True), (1, 0))
            self.assertFalse(any('push' in c.args[0] for c in run.call_args_list))
    def test_containment_never_assumes_a_squash_or_divergence_is_merged(self):
        self.assertFalse(module.contained({'status': 'ahead', 'behind_by': 0, 'merge_base_commit': {'sha': 'other'}}, 'a'))
        self.assertFalse(module.contained({'status': 'diverged', 'behind_by': 1, 'merge_base_commit': {'sha': 'a'}}, 'a'))
