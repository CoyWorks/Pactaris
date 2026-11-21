#!/usr/bin/env python3
"""Server housekeeping for Pactaris installations (docs/MAINTENANCE.md).

Prunes local database checkpoints, old release directories, failed releases, build logs and an
oversized npm cache under each component, removes dangling container images and keeps journald
bounded. Every component is handled under its own operation lock, so nothing is removed while an
install, update or backup runs. `--dry-run` reports what would go without changing anything.
Output is one JSON line per action; no secrets or file contents are printed.
"""
import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

COMPONENTS = ('instance', 'gateway', 'identity')
DEFAULTS = {'daily': 7, 'weekly': 4, 'monthly': 3, 'incompleteDays': 2, 'releases': 1, 'failedReleases': 3,
            'buildLogs': 10, 'npmCacheMegabytes': 1024, 'journalMegabytes': 1024, 'journalDays': 30, 'images': True}
LIMITS = {'daily': (1, 60), 'weekly': (0, 52), 'monthly': (0, 24), 'incompleteDays': (1, 30), 'releases': (1, 10),
          'failedReleases': (0, 20), 'buildLogs': (1, 200), 'npmCacheMegabytes': (100, 100000),
          'journalMegabytes': (100, 100000), 'journalDays': (7, 3650)}
CHECKPOINT = re.compile(r'[0-9]{19}')
REVISION = re.compile(r'[0-9a-f]{40}')


class HousekeepingError(Exception):
    pass


def emit(code, **fields):
    print(json.dumps({'code': code, **fields}, sort_keys=True), flush=True)


def load_config(path):
    if not path or not Path(path).exists():
        return dict(DEFAULTS)
    try:
        raw = json.loads(Path(path).read_text())
    except (OSError, ValueError):
        raise HousekeepingError('housekeeping.config')
    if not isinstance(raw, dict) or set(raw) - set(DEFAULTS):
        raise HousekeepingError('housekeeping.config')
    cfg = dict(DEFAULTS)
    for key, value in raw.items():
        if key == 'images':
            if type(value) is not bool:
                raise HousekeepingError('housekeeping.config')
        else:
            low, high = LIMITS[key]
            if type(value) is not int or not low <= value <= high:
                raise HousekeepingError('housekeeping.config')
        cfg[key] = value
    return cfg


def real_directory(path):
    return path.is_dir() and not path.is_symlink()


def size_of(path):
    total = 0
    for root, dirs, files in os.walk(path, followlinks=False):
        for name in files:
            try:
                total += (Path(root) / name).lstat().st_size
            except OSError:
                pass
    return total


def remove(path, dry, kind, component):
    """Removes a directory or file that is not a symlink, and reports it."""
    if path.is_symlink():
        return False
    emit('housekeeping.remove', component=component, kind=kind, name=path.name, dry=dry)
    if not dry:
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()
    return True


def completed(checkpoint, component):
    marker = checkpoint / 'backup.completed.json'
    try:
        meta = json.loads(marker.read_text())
        return meta.get('component') == component and meta.get('scope') == 'database-checkpoint'
    except (OSError, ValueError, AttributeError):
        return False


def keep_checkpoints(names, cfg, now):
    """Newest `daily` checkpoints, plus the newest of each of the last `weekly` ISO weeks and
    `monthly` months. The newest completed checkpoint is always kept."""
    stamps = sorted(names, reverse=True)
    keep = set(stamps[:cfg['daily']])
    weeks, months = {}, {}
    for name in stamps:
        when = datetime.fromtimestamp(int(name) / 1e9, timezone.utc)
        weeks.setdefault(when.isocalendar()[:2], name)
        months.setdefault((when.year, when.month), name)
    keep.update(list(weeks.values())[:cfg['weekly']])
    keep.update(list(months.values())[:cfg['monthly']])
    if stamps:
        keep.add(stamps[0])
    return keep


def prune_checkpoints(base, component, cfg, dry, now):
    directory = base / 'backups'
    if not real_directory(directory):
        return 0
    complete, removed = [], 0
    for entry in directory.iterdir():
        if entry.is_symlink() or not entry.is_dir() or not CHECKPOINT.fullmatch(entry.name):
            continue
        if completed(entry, component):
            complete.append(entry.name)
        elif now - int(entry.name) / 1e9 > cfg['incompleteDays'] * 86400:
            removed += remove(entry, dry, 'incompleteCheckpoint', component)
    keep = keep_checkpoints(complete, cfg, now)
    for name in complete:
        if name not in keep:
            removed += remove(directory / name, dry, 'checkpoint', component)
    return removed


def prune_releases(base, component, cfg, dry):
    directory = base / 'releases'
    if not real_directory(directory):
        return 0
    protected = set()
    for link in (base / 'current',):
        if link.is_symlink():
            protected.add(link.resolve())
    try:
        state = json.loads((base / 'state.json').read_text())
        protected.add(Path(state['release']).resolve())
    except (OSError, ValueError, KeyError, TypeError):
        # Without a readable state nothing is safe to judge; leave all releases.
        return 0
    candidates = [e for e in directory.iterdir() if REVISION.fullmatch(e.name) and real_directory(e) and e.resolve() not in protected]
    candidates.sort(key=lambda e: e.stat().st_mtime, reverse=True)
    removed = 0
    for entry in candidates[cfg['releases']:]:
        removed += remove(entry, dry, 'release', component)
    return removed


def prune_newest(directory, component, keep, dry, kind):
    if not real_directory(directory):
        return 0
    entries = sorted((e for e in directory.iterdir() if not e.is_symlink()), key=lambda e: e.stat().st_mtime, reverse=True)
    return sum(remove(e, dry, kind, component) for e in entries[keep:])


def prune_npm_cache(base, component, cfg, dry):
    cache = base / 'data' / 'npm-cache'
    if not real_directory(cache):
        return 0
    if size_of(cache) <= cfg['npmCacheMegabytes'] * 1024 * 1024:
        return 0
    return int(remove(cache, dry, 'npmCache', component))


def locked(base):
    """The component's operation lock, or None when an install, update or backup holds it."""
    lock = open(base / 'operation.lock', 'a')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        lock.close()
        return None
    return lock


def component_pass(base, component, cfg, dry, now):
    lock = locked(base)
    if lock is None:
        emit('housekeeping.locked', component=component)
        return None
    try:
        return {
            'checkpoints': prune_checkpoints(base, component, cfg, dry, now),
            'releases': prune_releases(base, component, cfg, dry),
            'failedReleases': prune_newest(base / 'failed-releases', component, cfg['failedReleases'], dry, 'failedRelease'),
            'buildLogs': prune_newest(base / 'build-logs', component, cfg['buildLogs'], dry, 'buildLog'),
            'npmCache': prune_npm_cache(base, component, cfg, dry),
        }
    finally:
        lock.close()


def system_pass(cfg, dry, identity_installed):
    if cfg['images'] and identity_installed and shutil.which('docker'):
        # Dangling images only: an image a container uses, or any tagged image, is never removed.
        if dry:
            listed = subprocess.run(['docker', 'images', '--filter', 'dangling=true', '-q'], capture_output=True, text=True, timeout=120)
            emit('housekeeping.images', dry=True, count=len(listed.stdout.split()) if listed.returncode == 0 else None)
        else:
            result = subprocess.run(['docker', 'image', 'prune', '-f'], capture_output=True, text=True, timeout=600)
            emit('housekeeping.images', dry=False, ok=result.returncode == 0)
    if shutil.which('journalctl'):
        if dry:
            emit('housekeeping.journal', dry=True, megabytes=cfg['journalMegabytes'], days=cfg['journalDays'])
        else:
            result = subprocess.run(['journalctl', f"--vacuum-size={cfg['journalMegabytes']}M", f"--vacuum-time={cfg['journalDays']}d"],
                                    capture_output=True, text=True, timeout=600)
            emit('housekeeping.journal', dry=False, ok=result.returncode == 0)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument('--root', default='/opt/pactaris')
    parser.add_argument('--config', default='/etc/pactaris/housekeeping.json')
    parser.add_argument('--state-dir')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args(argv)
    try:
        cfg = load_config(args.config)
        root = Path(args.root)
        if not real_directory(root):
            raise HousekeepingError('housekeeping.root')
        now, results = time.time(), {}
        for component in COMPONENTS:
            base = root / component
            if real_directory(base) and (base / 'state.json').is_file():
                results[component] = component_pass(base, component, cfg, args.dry_run, now)
        system_pass(cfg, args.dry_run, 'identity' in results)
        emit('housekeeping.complete', dry=args.dry_run, results=results)
        if args.state_dir and not args.dry_run:
            state = Path(args.state_dir)
            state.mkdir(mode=0o700, parents=True, exist_ok=True)
            temp = state / 'state.json.tmp'
            temp.write_text(json.dumps({'completedAt': datetime.now(timezone.utc).isoformat(), 'results': results}))
            os.chmod(temp, 0o600)
            os.replace(temp, state / 'state.json')
        return 0
    except HousekeepingError as error:
        emit(str(error))
        return 2


if __name__ == '__main__':
    sys.exit(main())
