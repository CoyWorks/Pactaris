#!/usr/bin/env python3
"""Fetch main once, pin it, and update installed components using fresh tooling."""
import argparse
import fcntl
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile

from deploy import DeployError, Parser, emit, read_json, repository, run, safe_root, validate_config, preflight

ORDER = ('gateway', 'instance', 'identity')
DEFAULT_REPOSITORY = 'https://github.com/CoyWorks/Pactaris.git'

def installed(root, selected=None):
    result = []
    for component in ORDER:
        if selected and component != selected:
            continue
        base = root / component
        if (base / 'state.json').exists():
            safe_root(str(base))
            metadata = (base / 'state.json').stat()
            if metadata.st_uid != 0 or metadata.st_mode & 0o022:
                raise DeployError('cli.updateState', component=component)
            state = read_json(base / 'state.json')
            if not re.fullmatch(r'[a-f0-9]{40}', state.get('revision', '')):
                raise DeployError('cli.updateState', component=component)
            expected = base / 'releases' / state['revision']
            if (not Path(state.get('release', '')).is_absolute() or
                Path(state['release']).resolve() != expected.resolve() or
                not expected.is_dir() or expected.is_symlink()):
                raise DeployError('cli.updateState', component=component)
            result.append((component, state))
        elif (base / 'config.json').exists() or (base / 'releases').exists():
            raise DeployError('cli.incomplete')
    if not result:
        raise DeployError('cli.missing')
    return result

def identity_change(old, new):
    previous = (Path(old) / 'apps/identity/compose.yaml').read_text()
    target = (new / 'apps/identity/compose.yaml').read_text()
    images = lambda value: [line.strip() for line in value.splitlines() if line.strip().startswith('image:')]
    if images(previous) != images(target):
        raise DeployError('cli.updateIdentityReview')
    return previous != target

def child(command):
    # Inherit only the deployer's structured, secret-redacted progress stream.
    # Poll via run would hide that stream; subprocess.call preserves live progress.
    with subprocess.Popen(command, start_new_session=True) as process:
        try:
            result = process.wait()
        except BaseException:
            for signum, timeout in ((signal.SIGINT, 20), (signal.SIGTERM, 5), (signal.SIGKILL, 5)):
                if process.poll() is not None:
                    break
                try:
                    os.killpg(process.pid, signum)
                except ProcessLookupError:
                    break
                try:
                    process.wait(timeout=timeout)
                    break
                except subprocess.TimeoutExpired:
                    continue
            raise
        if result:
            raise DeployError('cli.updateStopped', code=result)

def execute(args, source):
    revision = run(['git', '-C', str(source), 'rev-parse', 'HEAD'])
    if revision != args.revision:
        raise DeployError('cli.updateSource')
    components = installed(Path(args.root), args.component)
    release = read_json(source / 'deploy/release.json')
    if release.get('protocol') not in (1, 2) or not isinstance(release.get('migrations'), list):
        raise DeployError('cli.updateSource')
    commands = []
    # Plan every selected component before changing the first service.
    for component, state in components:
        base = Path(args.root) / component
        config = validate_config(component, read_json(base / 'config.json'))
        preflight(component, base, config)
        unchanged = state['revision'] == revision
        if component == 'identity':
            unchanged = not identity_change(state['release'], source)
        if not unchanged and any(m.get('component') == component for m in release['migrations']):
            for key in ('migrationUrlFile', 'backupUrlFile'):
                path = Path(config['database'].get(key, ''))
                if not path.is_absolute() or not path.is_file() or path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
                    raise DeployError('cli.updatePrerequisite', component=component)
        command = [sys.executable, str(source / 'scripts/deploy.py'), 'update',
                   '--component', component, '--root', args.root,
                   '--repository', args.repository, '--revision', revision]
        if not unchanged:
            child(command)
        commands.append((component, unchanged, command))
    for component, unchanged, command in commands:
        if unchanged:
            emit('cli.updateUnchanged', component=component)
            if not args.check:
                child([sys.executable, str(source / 'scripts/deploy.py'), 'status',
                       '--component', component, '--root', args.root])
        elif not args.check:
            emit('cli.updateComponent', component=component, revision=revision)
            child(command + ['--apply'])
    emit('cli.updateChecked' if args.check else 'cli.updateComplete', revision=revision)
    return 0

def main(argv=None):
    parser = Parser(add_help=False)
    parser.add_argument('--root', default='/opt/pactaris')
    parser.add_argument('--repository', default=DEFAULT_REPOSITORY)
    parser.add_argument('--component', choices=ORDER)
    parser.add_argument('--revision')
    parser.add_argument('--check', '--plan', action='store_true')
    parser.add_argument('--apply', action='store_true')  # Backward-compatible; now the default.
    parser.add_argument('--staged-source', help=argparse.SUPPRESS)
    values = list(sys.argv[1:] if argv is None else argv)
    if '--help' in values:
        emit('cli.updateHelp')
        return 0
    try:
        args = parser.parse_args(values)
        if os.geteuid() != 0:
            raise DeployError('cli.updateRoot')
        root = safe_root(args.root)
        repository(args.repository)
        if args.revision and not re.fullmatch(r'[a-f0-9]{40}', args.revision):
            raise DeployError('cli.updateSource')
        if args.check and args.apply:
            raise DeployError('cli.arguments')
        if args.staged_source:
            # Internal handoff executes the fetched updater, so future fixes apply
            # without modifying or resetting the operator's source checkout.
            source = Path(args.staged_source)
            if not args.revision or source.is_symlink() or source.stat().st_uid != 0 or source.stat().st_mode & 0o022:
                raise DeployError('cli.updateSource')
            return execute(args, source)
        installed(root, args.component)
        lockfile = root / 'update.lock'
        fd = os.open(lockfile, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                raise DeployError('cli.locked')
            with tempfile.TemporaryDirectory(prefix='pactaris-update-') as folder:
                source = Path(folder) / 'source'
                emit('cli.updateFetching')
                run(['git', 'init', '--quiet', str(source)])
                run(['git', '-C', str(source), 'remote', 'add', 'origin', args.repository])
                run(['git', '-C', str(source), 'fetch', '--no-tags', 'origin', args.revision or 'refs/heads/main'])
                revision = run(['git', '-C', str(source), 'rev-parse', 'FETCH_HEAD'])
                if not re.fullmatch(r'[a-f0-9]{40}', revision) or (args.revision and args.revision != revision):
                    raise DeployError('cli.updateSource')
                run(['git', '-C', str(source), 'checkout', '--quiet', '--detach', revision])
                if not (source / 'scripts/update.py').is_file():
                    raise DeployError('cli.updateSource')
                emit('cli.updateSelected', revision=revision)
                command = [sys.executable, str(source / 'scripts/update.py'), '--staged-source', str(source),
                           '--root', args.root, '--repository', args.repository, '--revision', revision]
                if args.component:
                    command += ['--component', args.component]
                if args.check:
                    command += ['--check']
                child(command)
        return 0
    except KeyboardInterrupt:
        emit('cli.interrupted')
        return 130
    except DeployError as error:
        emit(error.key, **error.params)
        return 1
    except Exception:
        emit('cli.failed')
        return 1

if __name__ == '__main__':
    sys.exit(main())
