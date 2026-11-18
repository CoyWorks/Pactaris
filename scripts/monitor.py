"""Report service health and backup age without printing deployment secrets."""

import contextlib
from datetime import datetime, timezone
import io
from pathlib import Path
import re
import shutil
import signal
import sys
import time

from deploy import COMPONENTS, DeployError, Parser, emit, health, read_json, safe_root, validate_config


def age_seconds(value, now):
    try:
        timestamp = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if timestamp.tzinfo is None:
            return None
        elapsed = (now - timestamp).total_seconds()
        return int(elapsed) if elapsed >= 0 else None
    except (AttributeError, ValueError):
        return None


def checkpoint_age(base, now):
    directory = base / 'backups'
    if not directory.is_dir() or directory.is_symlink():
        return None
    for candidate in sorted(directory.iterdir(), key=lambda path: path.name, reverse=True):
        if not re.fullmatch(r'[0-9]{19}', candidate.name) or candidate.is_symlink():
            continue
        marker, dump = candidate / 'backup.completed.json', candidate / 'database.sql'
        if not marker.is_file() or dump.is_symlink() or not dump.is_file():
            continue
        try:
            metadata = read_json(marker)
            if (metadata['component'] == base.name and metadata['scope'] == 'database-checkpoint'
                    and 0 < metadata['bytes'] == dump.stat().st_size):
                age = age_seconds(metadata['completedAt'], now)
                if age is not None:
                    return age
        except (DeployError, OSError, TypeError, KeyError):
            continue
    return None


def report(base):
    state = read_json(base / 'state.json')
    cfg = validate_config(base.name, read_json(base / 'config.json'))
    revision = state['revision'] if re.fullmatch(r'[a-f0-9]{40}', state['revision']) else None
    started = time.monotonic()
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            health(base, cfg, Path(state['release']))
            ready = True
        except Exception:
            ready = False
    duration_ms = round((time.monotonic() - started) * 1000)
    now = datetime.now(timezone.utc)
    heartbeat_age = None
    if base.name != 'identity':
        try:
            heartbeat = read_json(Path(cfg['worker']['heartbeatFile']))
            heartbeat_age = age_seconds(heartbeat.get('checkedAt'), now)
        except (DeployError, OSError, TypeError, KeyError):
            pass
    usage = shutil.disk_usage(base)
    return {
        'component': base.name, 'revision': revision, 'ready': ready,
        'probeDurationMs': duration_ms, 'workerHeartbeatAgeSeconds': heartbeat_age,
        'databaseCheckpointAgeSeconds': checkpoint_age(base, now),
        'installationDiskFreeBytes': usage.free,
    }


def probe_deadline(_signal, _frame):
    raise TimeoutError('monitor.deadline')


def main(argv=None):
    parser = Parser(add_help=False)
    parser.add_argument('--component', choices=COMPONENTS, required=True)
    parser.add_argument('--root', default='/opt/pactaris')
    try:
        args = parser.parse_args(argv)
        signal.signal(signal.SIGALRM, probe_deadline)
        signal.alarm(20)
        try:
            base = safe_root(str(Path(args.root) / args.component))
            result = report(base)
        finally:
            signal.alarm(0)
        emit('cli.monitor', **result)
        return 0 if result['ready'] else 1
    except (DeployError, OSError, ValueError, TypeError, KeyError):
        emit('cli.monitorFailed')
        return 1


if __name__ == '__main__':
    sys.exit(main())
