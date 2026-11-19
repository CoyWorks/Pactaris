#!/usr/bin/env python3
"""Create, encrypt and copy Pactaris database checkpoints to an off-host target."""

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

COMPONENTS = ('instance', 'gateway', 'identity')
RECIPIENT = re.compile(r'age1[023456789acdefghjklmnpqrstuvwxyz]{58}')
SAFE_PATH = re.compile(r'/[A-Za-z0-9._/-]{1,200}')
HOST = re.compile(r'[A-Za-z0-9.-]{1,253}')
USER = re.compile(r'[a-z_][a-z0-9_-]{0,31}')
ARCHIVE = re.compile(r'(instance|gateway|identity)-[0-9]{8}T[0-9]{6}Z-[0-9]{19}\.tar\.age')


def event(name, **fields):
    print(json.dumps({'event': name, **fields}), flush=True)


class BackupError(Exception):
    pass


def load_config(path):
    """Validate the root-only target file. Shell-relevant values must match strict patterns."""
    info = path.lstat()
    if not path.is_file() or path.is_symlink() or info.st_uid != 0 or info.st_mode & 0o077:
        raise BackupError('offsite.config_permissions')
    cfg = json.loads(path.read_text())
    if not isinstance(cfg, dict) or set(cfg) - {'recipient', 'target', 'keep', 'components'}:
        raise BackupError('offsite.config')
    if not isinstance(cfg.get('recipient'), str) or not RECIPIENT.fullmatch(cfg['recipient']):
        raise BackupError('offsite.config_recipient')
    keep = cfg.get('keep', 14)
    if type(keep) is not int or not 1 <= keep <= 365:
        raise BackupError('offsite.config_keep')
    components = cfg.get('components', list(COMPONENTS))
    if not isinstance(components, list) or not components or any(c not in COMPONENTS for c in components) or len(set(components)) != len(components):
        raise BackupError('offsite.config_components')
    target = cfg.get('target')
    if not isinstance(target, dict) or target.get('type') not in ('directory', 'ssh'):
        raise BackupError('offsite.config_target')
    if not isinstance(target.get('path'), str) or not SAFE_PATH.fullmatch(target['path']) or '..' in target['path'].split('/'):
        raise BackupError('offsite.config_target')
    if target['type'] == 'directory':
        if set(target) != {'type', 'path'}:
            raise BackupError('offsite.config_target')
    else:
        if set(target) - {'type', 'path', 'host', 'user', 'port', 'identityFile', 'knownHostsFile'}:
            raise BackupError('offsite.config_target')
        port = target.get('port', 22)
        if (not isinstance(target.get('host'), str) or not HOST.fullmatch(target['host']) or target['host'].startswith('-')
                or not isinstance(target.get('user'), str) or not USER.fullmatch(target['user'])
                or type(port) is not int or not 1 <= port <= 65535):
            raise BackupError('offsite.config_target')
        for key in ('identityFile', 'knownHostsFile'):
            if not isinstance(target.get(key), str) or not SAFE_PATH.fullmatch(target[key]):
                raise BackupError('offsite.config_target')
        target['port'] = port
    return {'recipient': cfg['recipient'], 'target': target, 'keep': keep, 'components': components}


def tooling(root):
    """Use the newest installed release tooling; every release ships backup.sh and the encryptor."""
    for component in ('gateway', 'instance'):
        release = root / component / 'current'
        if (release / 'backup.sh').is_file() and (release / 'scripts/encrypt_checkpoint.py').is_file():
            return release
    raise BackupError('offsite.tooling')


def run(command):
    return subprocess.run(command, check=False, capture_output=True, text=True, timeout=3600)


def checkpoint(release, root, component):
    result = run(['/bin/bash', str(release / 'backup.sh'), '--component', component, '--apply'])
    if result.returncode:
        raise BackupError('offsite.checkpoint_failed')
    for line in reversed(result.stdout.splitlines()):
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get('messageKey') == 'cli.backupComplete' and message.get('component') == component:
            path = Path(message['path'])
            if path.parent == root / component / 'backups' and re.fullmatch(r'[0-9]{19}', path.name):
                return path
    raise BackupError('offsite.checkpoint_unknown')


def encrypt(release, source, staging, component, recipient):
    stamp = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    destination = staging / f'{component}-{stamp}-{source.name}.tar.age'
    result = run(['/usr/bin/python3', str(release / 'scripts/encrypt_checkpoint.py'),
                  '--checkpoint', str(source), '--output', str(destination), '--recipient', recipient])
    if result.returncode or not destination.is_file():
        raise BackupError('offsite.encrypt_failed')
    return destination


def ssh_base(target):
    return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', f"UserKnownHostsFile={target['knownHostsFile']}",
            '-o', 'IdentitiesOnly=yes', '-i', target['identityFile']]


def ssh(target, remote_command):
    return run(['ssh', *ssh_base(target), '-p', str(target['port']), '--', f"{target['user']}@{target['host']}", remote_command])


def publish(archive, target, component):
    """Copy under a temporary name first, so a partial transfer is never a visible backup."""
    folder = f"{target['path'].rstrip('/')}/{component}"
    if target['type'] == 'directory':
        directory = Path(folder)
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        fd, temp = tempfile.mkstemp(dir=directory, prefix='.partial-')
        try:
            with os.fdopen(fd, 'wb') as output, open(archive, 'rb') as source:
                shutil.copyfileobj(source, output)
                output.flush()
                os.fsync(output.fileno())
            os.link(temp, directory / archive.name)
        finally:
            Path(temp).unlink(missing_ok=True)
        return
    partial = f'{folder}/.partial-{archive.name}'
    if ssh(target, f'mkdir -p -m 700 -- {folder}').returncode:
        raise BackupError('offsite.transfer_failed')
    copy = run(['scp', '-q', *ssh_base(target), '-P', str(target['port']), '--', str(archive), f"{target['user']}@{target['host']}:{partial}"])
    if copy.returncode or ssh(target, f'mv -n -- {partial} {folder}/{archive.name}').returncode:
        raise BackupError('offsite.transfer_failed')


def prune(target, component, keep):
    """Keep the newest archives per component. Only names this tool writes are considered."""
    folder = f"{target['path'].rstrip('/')}/{component}"
    if target['type'] == 'directory':
        names = sorted(p.name for p in Path(folder).iterdir() if ARCHIVE.fullmatch(p.name) and p.name.startswith(component + '-'))
        for name in names[:-keep]:
            (Path(folder) / name).unlink()
        return len(names[:-keep])
    listing = ssh(target, f'ls -1 -- {folder}')
    if listing.returncode:
        raise BackupError('offsite.prune_failed')
    names = sorted(n for n in listing.stdout.split() if ARCHIVE.fullmatch(n) and n.startswith(component + '-'))
    for name in names[:-keep]:
        if ssh(target, f'rm -f -- {folder}/{name}').returncode:
            raise BackupError('offsite.prune_failed')
    return len(names[:-keep])


def write_state(path, value):
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.state-')
    with os.fdopen(fd, 'w') as handle:
        json.dump(value, handle)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp, path)


def backup(cfg, root, state_dir):
    release = tooling(root)
    staging = state_dir / 'staging'
    staging.mkdir(mode=0o700, parents=True, exist_ok=True)
    state_path = state_dir / 'state.json'
    state = json.loads(state_path.read_text()) if state_path.is_file() else {}
    failed = 0
    for component in cfg['components']:
        if not (root / component / 'state.json').is_file():
            continue
        archive = None
        try:
            source = checkpoint(release, root, component)
            archive = encrypt(release, source, staging, component, cfg['recipient'])
            publish(archive, cfg['target'], component)
            pruned = prune(cfg['target'], component, cfg['keep'])
            state[component] = {'lastSuccessAt': datetime.now(timezone.utc).isoformat(), 'archive': archive.name}
            event('offsite.backup_complete', component=component, archive=archive.name, pruned=pruned)
        except (BackupError, OSError, ValueError, subprocess.TimeoutExpired) as error:
            failed += 1
            state.setdefault(component, {})['lastFailureAt'] = datetime.now(timezone.utc).isoformat()
            event('offsite.backup_failed', component=component, code=str(error) if isinstance(error, BackupError) else 'offsite.error')
        finally:
            if archive:
                archive.unlink(missing_ok=True)
        write_state(state_path, state)
    return 1 if failed else 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/pactaris/offsite-backup.json'))
    parser.add_argument('--root', type=Path, default=Path('/opt/pactaris'))
    parser.add_argument('--state-dir', type=Path, default=Path('/var/lib/pactaris-offsite-backup'))
    args = parser.parse_args(argv)
    if not args.config.exists():
        # Installed before a target exists: harmless until the operator adds the file.
        event('offsite.not_configured')
        return 0
    try:
        return backup(load_config(args.config), args.root, args.state_dir)
    except (BackupError, OSError, ValueError) as error:
        event('offsite.backup_failed', code=str(error) if isinstance(error, BackupError) else 'offsite.config')
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
