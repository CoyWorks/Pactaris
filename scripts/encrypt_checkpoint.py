"""Stream a completed database checkpoint into an age-encrypted archive."""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

from deploy import DeployError, emit, safe_root

FILES = ('database.sql', 'backup.completed.json', 'config.json', 'state.json', 'identity.env')


def checkpoint_files(source):
    files = {}
    for name in FILES:
        path = source / name
        try:
            info = path.lstat()
        except FileNotFoundError:
            if name in FILES[:3]:
                raise
            continue
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022:
            raise ValueError('backup.file')
        files[name] = path
    marker = json.loads(files['backup.completed.json'].read_text())
    size = files['database.sql'].stat().st_size
    if marker.get('scope') != 'database-checkpoint' or not size or marker.get('bytes') != size:
        raise ValueError('backup.incomplete')
    return files


def encrypt(source, destination, recipient):
    files = checkpoint_files(source)
    fd, name = tempfile.mkstemp(dir=destination.parent, prefix='.pactaris-age-')
    temp = Path(name)
    try:
        with os.fdopen(fd, 'wb') as target:
            with subprocess.Popen(['age', '-r', recipient], stdin=subprocess.PIPE, stdout=target,
                                  stderr=subprocess.DEVNULL) as process:
                try:
                    with tarfile.open(fileobj=process.stdin, mode='w|') as archive:
                        for entry, path in files.items():
                            archive.add(path, arcname=entry, recursive=False)
                    process.stdin.close()
                    if process.wait() != 0:
                        raise ValueError('backup.encrypt')
                except BaseException:
                    process.kill()
                    raise
            target.flush()
            if not target.tell():
                raise ValueError('backup.encrypt')
            os.fsync(target.fileno())
        # Publish atomically without replacing another backup.
        os.link(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--checkpoint', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--recipient', required=True)
    args = parser.parse_args(argv)
    try:
        if os.geteuid() != 0 or not re.fullmatch(r'age1[023456789acdefghjklmnpqrstuvwxyz]{58}', args.recipient):
            raise ValueError('backup.args')
        source = safe_root(args.checkpoint)
        destination = args.output
        safe_root(str(destination.parent))
        if not destination.name.endswith('.tar.age') or destination.exists():
            raise ValueError('backup.destination')
        encrypt(source, destination, args.recipient)
        emit('cli.offhostBackupReady', path=str(destination))
        return 0
    except (DeployError, OSError, ValueError, TypeError, tarfile.TarError):
        emit('cli.offhostBackupFailed')
        return 1


if __name__ == '__main__':
    sys.exit(main())
