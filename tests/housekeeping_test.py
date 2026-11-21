import fcntl
import io
import json
import os
import sys
import tempfile
import time
import unittest
from contextlib import redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import housekeeping  # noqa: E402

DAY = 86400


def checkpoint(base, component, seconds_ago, complete=True):
    name = str(int((time.time() - seconds_ago) * 1e9))
    path = base / 'backups' / name
    path.mkdir(parents=True)
    (path / 'database.sql').write_text('fixture')
    if complete:
        (path / 'backup.completed.json').write_text(json.dumps({'component': component, 'scope': 'database-checkpoint'}))
    return name


def quiet(function, *args):
    with redirect_stdout(io.StringIO()) as out:
        result = function(*args)
    return result, [json.loads(line) for line in out.getvalue().splitlines()]


class HousekeepingTest(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.root = Path(self.folder.name)
        self.base = self.root / 'gateway'
        self.base.mkdir()
        cfg = dict(housekeeping.DEFAULTS, images=False)
        self.cfg = cfg

    def tearDown(self):
        self.folder.cleanup()

    def release(self, revision, age):
        path = self.base / 'releases' / revision
        path.mkdir(parents=True)
        os.utime(path, (time.time() - age, time.time() - age))
        return path

    def test_checkpoints_keep_daily_weekly_monthly_and_drop_stale_incomplete(self):
        names = [checkpoint(self.base, 'gateway', day * DAY + 60) for day in range(0, 120, 3)]
        stale = checkpoint(self.base, 'gateway', 5 * DAY, complete=False)
        fresh = checkpoint(self.base, 'gateway', 3600, complete=False)
        other = checkpoint(self.base, 'instance', 200 * DAY)  # marker for another component: treated as incomplete
        (self.base / 'backups' / 'not-a-checkpoint').mkdir()
        removed, _ = quiet(housekeeping.prune_checkpoints, self.base, 'gateway', self.cfg, True, time.time())
        self.assertTrue(all((self.base / 'backups' / n).exists() for n in names), 'dry run removed something')
        removed, _ = quiet(housekeeping.prune_checkpoints, self.base, 'gateway', self.cfg, False, time.time())
        left = {p.name for p in (self.base / 'backups').iterdir()}
        kept = [n for n in names if n in left]
        self.assertIn(max(names), left)
        self.assertGreaterEqual(len(kept), 7)
        self.assertLess(len(kept), len(names))
        self.assertNotIn(stale, left)
        self.assertNotIn(other, left)
        self.assertIn(fresh, left)
        self.assertIn('not-a-checkpoint', left)
        self.assertEqual(removed, len(names) - len(kept) + 2)

    def test_releases_keep_current_state_and_one_previous(self):
        current = self.release('a' * 40, 10)
        previous = self.release('b' * 40, 1000)
        old = self.release('c' * 40, 5000)
        older = self.release('d' * 40, 9000)
        (self.base / 'current').symlink_to(current)
        (self.base / 'state.json').write_text(json.dumps({'release': str(current)}))
        quiet(housekeeping.prune_releases, self.base, 'gateway', self.cfg, False)
        self.assertTrue(current.exists() and previous.exists())
        self.assertFalse(old.exists() or older.exists())

    def test_releases_untouched_without_readable_state(self):
        self.release('a' * 40, 10)
        self.release('b' * 40, 1000)
        self.release('c' * 40, 5000)
        removed, _ = quiet(housekeeping.prune_releases, self.base, 'gateway', self.cfg, False)
        self.assertEqual(removed, 0)

    def test_symlinks_are_never_followed_or_removed(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'keep').write_text('x')
        (self.base / 'build-logs').mkdir()
        for index in range(15):
            entry = self.base / 'build-logs' / f'log-{index}'
            entry.mkdir()
            os.utime(entry, (time.time() - index, time.time() - index))
        (self.base / 'build-logs' / 'link').symlink_to(outside)
        quiet(housekeeping.prune_newest, self.base / 'build-logs', 'gateway', 10, False, 'buildLog')
        self.assertTrue((outside / 'keep').exists())
        self.assertTrue((self.base / 'build-logs' / 'link').is_symlink())
        self.assertEqual(len([p for p in (self.base / 'build-logs').iterdir() if not p.is_symlink()]), 10)

    def test_npm_cache_removed_only_when_oversized(self):
        cache = self.base / 'data' / 'npm-cache'
        cache.mkdir(parents=True)
        (cache / 'blob').write_bytes(b'x' * 2048)
        self.assertEqual(quiet(housekeeping.prune_npm_cache, self.base, 'gateway', self.cfg, False)[0], 0)
        small = dict(self.cfg, npmCacheMegabytes=100)
        (cache / 'big').write_bytes(b'x' * (101 * 1024 * 1024))
        self.assertEqual(quiet(housekeeping.prune_npm_cache, self.base, 'gateway', small, False)[0], 1)
        self.assertFalse(cache.exists())

    def test_component_is_skipped_while_its_operation_lock_is_held(self):
        checkpoint(self.base, 'gateway', 5 * DAY, complete=False)
        with open(self.base / 'operation.lock', 'a') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            result, lines = quiet(housekeeping.component_pass, self.base, 'gateway', self.cfg, False, time.time())
        self.assertIsNone(result)
        self.assertEqual(lines[0]['code'], 'housekeeping.locked')
        self.assertEqual(len(list((self.base / 'backups').iterdir())), 1)

    def test_config_is_validated(self):
        path = self.root / 'housekeeping.json'
        path.write_text(json.dumps({'daily': 3, 'images': False}))
        self.assertEqual(housekeeping.load_config(str(path))['daily'], 3)
        for bad in ({'daily': 0}, {'unknown': 1}, {'images': 'yes'}, {'journalDays': 1}):
            path.write_text(json.dumps(bad))
            with self.assertRaises(housekeeping.HousekeepingError):
                housekeeping.load_config(str(path))
        self.assertEqual(housekeeping.load_config(str(self.root / 'missing.json')), housekeeping.DEFAULTS)

    def test_main_dry_run_changes_nothing(self):
        (self.base / 'state.json').write_text(json.dumps({'release': str(self.base / 'releases' / ('a' * 40))}))
        stale = checkpoint(self.base, 'gateway', 5 * DAY, complete=False)
        config = self.root / 'housekeeping.json'
        config.write_text(json.dumps({'images': False}))
        code, lines = quiet(housekeeping.main, ['--root', str(self.root), '--config', str(config), '--dry-run'])
        self.assertEqual(code, 0)
        self.assertTrue((self.base / 'backups' / stale).exists())
        self.assertEqual(lines[-1]['code'], 'housekeeping.complete')


if __name__ == '__main__':
    unittest.main()
