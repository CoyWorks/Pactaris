#!/usr/bin/env python3
"""Initialise a gateway SMTP relay without replacing existing keys or settings."""
import getpass
import grp
import hashlib
import json
import os
import secrets
import shutil
import stat
import sys
from pathlib import Path


def setup(base, email, password):
    config_path = base / 'config.json'
    mail_path = base / 'data' / 'invitation-mail.json'
    if mail_path.exists() or mail_path.is_symlink():
        raise ValueError('SMTP file already exists; preserve its encryption key.')
    if config_path.is_symlink() or not config_path.is_file():
        raise ValueError('Gateway config must be an existing regular file.')
    config = json.loads(config_path.read_text())
    if 'invitationMailFile' in config:
        raise ValueError('Gateway already has invitationMailFile configured.')
    if not email or '@' not in email or not password:
        raise ValueError('A mailbox address and password are required.')
    suffix = hashlib.sha256(str(base).encode()).hexdigest()[:8]
    group = grp.getgrnam('pactaris-gateway-' + suffix).gr_gid
    backup = config_path.with_name('config.json.before-invitation-smtp')
    if backup.exists() or backup.is_symlink():
        raise ValueError('Backup already exists; inspect it before continuing.')
    os.umask(0o077)
    with open(backup, 'x') as out:
        out.write(config_path.read_text())
    os.chmod(backup, 0o600)
    data = {'host': 'smtp.mail.ovh.net', 'port': 465, 'tls': 'implicit',
            'from': email, 'username': email, 'password': password,
            'encryptionKey': secrets.token_hex(32)}
    fd = os.open(mail_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(data, out, indent=2)
        out.write('\n')
    os.chown(mail_path, 0, group)
    os.chmod(mail_path, 0o640)
    config['invitationMailFile'] = str(mail_path)
    temporary = config_path.with_name('config.json.invitation-smtp-tmp')
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'w') as out:
        json.dump(config, out, indent=2)
        out.write('\n')
    info = config_path.stat()
    os.chown(temporary, info.st_uid, info.st_gid)
    os.chmod(temporary, stat.S_IMODE(info.st_mode))
    os.replace(temporary, config_path)
    return suffix, backup


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root.')
    base = Path('/opt/pactaris/gateway')
    email = input('OVH mailbox email: ').strip()
    password = getpass.getpass('OVH mailbox password: ')
    try:
        suffix, backup = setup(base, email, password)
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as exc:
        raise SystemExit('Setup stopped: ' + str(exc)) from exc
    print('SMTP configured. Gateway config backup:', backup)
    print('Restart the gateway and worker to apply:')
    print('systemctl restart pactaris-gateway-' + suffix + '.service pactaris-gateway-' + suffix + '-worker.service')
    print('Keep the SMTP file and its encryption key in secure backups.')


if __name__ == '__main__':
    main()
