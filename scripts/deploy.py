#!/usr/bin/env python3
"""First foundation deployer. JSON configuration is data, never sourced shell code."""
from __future__ import annotations
import argparse
import contextlib
import fcntl
import hashlib
import http.client
import ipaddress
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import signal
import shutil
import socket
import ssl
import subprocess
import sys
import tarfile
import tempfile
import time
from urllib.parse import parse_qsl, unquote, urlsplit

SOURCE = Path(__file__).resolve().parent.parent
MESSAGES = json.loads((SOURCE / 'locales/en/messages.json').read_text())
COMPONENTS = ('identity', 'instance', 'gateway')
PROTOCOL = 2

class DeployError(Exception):
    def __init__(self, key='cli.preflight', **params):
        self.key, self.params = key, params

def fail(check):
    raise DeployError(check=check)

def emit(key, **params):
    message = MESSAGES[key]
    for name, value in params.items():
        message = message.replace('{' + name + '}', str(value))
    print(json.dumps({'messageKey': key, 'message': message, **params}), flush=True)

def run(args, *, cwd=None, env=None, user=None, output=None, error_file=None):
    command = list(args)
    if user:
        command = ['runuser', '-u', user, '--', *command]
    # Child output is captured, not echoed: tools may include credential-bearing URLs.
    tool = Path(args[0]).name
    emit('cli.command', tool=tool)
    started = time.monotonic()
    with subprocess.Popen(command, cwd=cwd, env=env, stdout=output or subprocess.PIPE,
                          stderr=subprocess.PIPE, start_new_session=True) as child:
        try:
            while True:
                try:
                    stdout, stderr = child.communicate(timeout=15)
                    break
                except subprocess.TimeoutExpired:
                    elapsed = int(time.monotonic() - started)
                    emit('cli.waiting', tool=tool, seconds=elapsed)
                    if elapsed >= 600:
                        raise DeployError('cli.commandFailed', tool=tool, code='timeout')
        except BaseException:
            # Stop the command group on cancellation too; do not leave npm/builds running.
            if child.poll() is None:
                os.killpg(child.pid, signal.SIGTERM)
                try:
                    child.communicate(timeout=5)
                except subprocess.TimeoutExpired:
                    os.killpg(child.pid, signal.SIGKILL)
                    child.communicate()
            raise
        if child.returncode:
            if error_file is not None:
                fd = os.open(error_file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(fd, 'wb') as log:
                    log.write(stderr)
                emit('cli.commandLog', path=str(error_file))
            raise DeployError('cli.commandFailed', tool=tool, code=child.returncode)
    return stdout.decode().strip() if stdout is not None else ''

def public_origin(value):
    if not isinstance(value, str):
        fail('publicOrigin')
    u = urlsplit(value)
    if u.scheme != 'https' or not u.hostname or u.username or u.password or u.query or u.fragment or u.path not in ('', '/'):
        fail('publicOrigin')
    try:
        _ = u.port
    except ValueError:
        fail('publicOrigin')
    return value.rstrip('/')

def validate_config(component, cfg):
    if not isinstance(cfg, dict):
        fail('config')
    public_origin(cfg.get('publicOrigin'))
    listen = cfg.get('listen', {})
    try:
        ipaddress.ip_address(listen['address'])
        if type(listen['port']) is not int or not 1024 <= listen['port'] <= 65535:
            fail('listen.port')
    except (KeyError, ValueError, TypeError):
        fail('listen')
    languages = json.loads((SOURCE / 'locales/manifest.json').read_text())['languages']
    if cfg.get('locale', {}).get('language') not in languages:
        fail('locale.language')
    if component != 'identity':
        if not re.fullmatch(r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}', cfg.get('gatewayId' if component == 'gateway' else 'instanceId', '')):
            fail('instanceId')
        tls = listen.get('tls', {})
        for key in ('certFile', 'keyFile', 'caFile'):
            if not isinstance(tls.get(key), str) or not Path(tls[key]).is_absolute():
                fail('tls.' + key)
        if not isinstance(tls.get('serverName'), str) or not tls['serverName'] or '\n' in tls['serverName']:
            fail('tls.serverName')
        u = urlsplit(cfg.get('database', {}).get('url', ''))
        if u.scheme not in ('postgres', 'postgresql') or not u.hostname or not u.path.strip('/'):
            fail('database.url')
    return cfg

def atomic_json(path, value, mode=0o600):
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, indent=2)
            stream.write('\n')
        os.replace(temp, path)
    finally:
        if temp.exists():
            temp.unlink()

def read_json(path):
    try:
        if path.is_symlink():
            fail('symlink')
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError):
        fail('config.file')

def service_identity(base):
    return 'pactaris-' + base.name + '-' + hashlib.sha256(str(base).encode()).hexdigest()[:8]

def unit_name(base, worker=False):
    suffix = '-worker' if worker else ''
    return service_identity(base) + suffix + '.service'

def render_unit(base, node, worker=False):
    command = 'worker' if worker else 'server'
    # Paths are constrained before interpolation into systemd syntax.
    user = service_identity(base)
    return f'''[Unit]
Description=Pactaris {base.name}{' worker' if worker else ''}
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
User={user}
Group={user}
WorkingDirectory={base}/current
Environment=NODE_ENV=production
Environment=APP_CONFIG={base}/config.json
ExecStart={node} {base}/current/dist/server/apps/{base.name}/{command}.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=15
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={base}/data
[Install]
WantedBy=multi-user.target
'''

def compose(base, release):
    return ['docker', 'compose', '--project-name', 'pactaris-' + base.name + '-' + hashlib.sha256(str(base).encode()).hexdigest()[:12],
            '--env-file', str(base / 'identity.env'), '-f', str(release / 'apps/identity/compose.yaml')]

def ensure_user(base):
    user = service_identity(base)
    try:
        info = pwd.getpwnam(user)
        if info.pw_uid == 0 or info.pw_shell not in ('/usr/sbin/nologin', '/sbin/nologin'):
            fail('service_user')
    except KeyError:
        run(['useradd', '--system', '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', user])
        info = pwd.getpwnam(user)
    return info

def health(base, cfg, release):
    if base.name == 'identity':
        run(compose(base, release) + ['exec', '-T', 'server', 'ak', 'healthcheck'])
        return
    tls = cfg['listen']['tls']
    context = ssl.create_default_context(cafile=tls['caFile'])
    # Connection target and verified TLS name are intentionally distinct.
    raw = socket.create_connection((cfg['listen']['address'], cfg['listen']['port']), timeout=4)
    with context.wrap_socket(raw, server_hostname=tls['serverName']) as sock:
        conn = http.client.HTTPConnection(tls['serverName'], timeout=4)
        conn.sock = sock
        conn.request('GET', '/health/ready', headers={'Host': urlsplit(cfg['publicOrigin']).netloc})
        response = conn.getresponse()
        if response.status != 200:
            fail('health')
        response.read()
    for worker in (False, True):
        run(['systemctl', 'is-active', '--quiet', unit_name(base, worker)])
    heartbeat = read_json(Path(cfg['worker']['heartbeatFile']))
    from datetime import datetime, timezone
    checked = datetime.fromisoformat(heartbeat['checkedAt'].replace('Z', '+00:00'))
    if heartbeat.get('state') != 'ready' or (datetime.now(timezone.utc) - checked).total_seconds() > cfg['worker']['intervalSeconds'] * 2 + 15:
        fail('worker_health')

def preflight(component, base, cfg):
    if os.geteuid() != 0:
        fail('root_required_for_apply')
    if sys.platform != 'linux' or not Path('/run/systemd/system').is_dir():
        fail('systemd_host')
    for executable in (('git', 'docker') if component == 'identity' else ('git', 'node', 'npm', 'runuser', 'useradd', 'pg_dump')):
        if not shutil.which(executable):
            fail(executable)
    if component == 'identity':
        run(['docker', 'compose', 'version'])
    else:
        if not run(['node', '--version']).startswith('v24.'):
            fail('node24')
        for key in ('certFile', 'keyFile', 'caFile'):
            if not Path(cfg['listen']['tls'][key]).is_file():
                fail('tls.' + key)

def repository(value):
    if not re.fullmatch(r'(https://github\.com/|git@github\.com:)[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\.git', value):
        fail('repository')
    return value

def safe_root(value):
    path = Path(value)
    if not path.is_absolute() or not re.fullmatch(r'/[A-Za-z0-9_./-]+', str(path)) or '..' in path.parts or path == Path('/'):
        fail('root_path')
    # Reject symlinked ancestors to keep privileged writes inside the operator's chosen root.
    if any(p.is_symlink() for p in [path, *path.parents]):
        fail('root_symlink')
    for parent in [path, *path.parents]:
        if parent.exists() and (parent.stat().st_mode & 0o022 or parent.stat().st_uid != 0):
            fail('root_permissions')
    return path

@contextlib.contextmanager
def postgres_environment(url, directory):
    # Environment-supplied PGDATABASE is a literal database name, not a parsed URI.
    u = urlsplit(url)
    fields = {'host': unquote(u.hostname or ''), 'port': str(u.port or 5432),
              'dbname': unquote(u.path.removeprefix('/')), 'user': unquote(u.username or '')}
    password = unquote(u.password or '')
    parameters = {'host': 'PGHOST', 'hostaddr': 'PGHOSTADDR', 'port': 'PGPORT',
                  'dbname': 'PGDATABASE', 'user': 'PGUSER', 'sslmode': 'PGSSLMODE',
                  'sslrootcert': 'PGSSLROOTCERT', 'sslcert': 'PGSSLCERT', 'sslkey': 'PGSSLKEY',
                  'channel_binding': 'PGCHANNELBINDING', 'target_session_attrs': 'PGTARGETSESSIONATTRS',
                  'application_name': 'PGAPPNAME', 'options': 'PGOPTIONS', 'connect_timeout': 'PGCONNECT_TIMEOUT'}
    for key, value in parse_qsl(u.query, keep_blank_values=True):
        if key == 'password':
            password = value
        elif key in parameters:
            fields[key] = value
        else:
            fail('database.backup_query_parameter')
    if not all(fields.get(key) for key in ('host', 'port', 'dbname', 'user')):
        fail('database.backup_connection')
    if any('\n' in value or '\r' in value or '\x00' in value for value in [*fields.values(), password]):
        fail('database.backup_connection')
    env = {key: value for key, value in os.environ.items() if not key.startswith('PG')}
    env['PGCONNECT_TIMEOUT'] = '5'
    env.update({parameters[key]: value for key, value in fields.items()})
    with tempfile.TemporaryDirectory(prefix='pactaris-pg-', dir=directory) as folder:
        path = Path(folder) / 'pgpass'
        escape = lambda value: value.replace('\\', '\\\\').replace(':', '\\:')
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as stream:
            stream.write(':'.join(escape(fields[key]) for key in ('host', 'port', 'dbname', 'user')) + ':' + escape(password) + '\n')
        env['PGPASSFILE'] = str(path)
        yield env

def checkpoint(base, cfg, previous):
    backup = base / 'backups' / str(time.time_ns())
    backup.mkdir(mode=0o700, parents=True)
    shutil.copy2(base / 'config.json', backup / 'config.json')
    if previous:
        atomic_json(backup / 'state.json', previous)
    if base.name == 'identity':
        if previous:
            with open(backup / 'database.sql', 'xb') as output:
                os.chmod(output.name, 0o600)
                run(compose(base, Path(previous['release'])) + ['exec', '-T', 'postgresql', 'pg_dump', '-U', 'authentik', '-d', 'authentik'], output=output)
        shutil.copy2(base / 'identity.env', backup / 'identity.env')
    else:
        partial = backup / 'database.sql.partial'
        backup_url_file = cfg['database'].get('backupUrlFile')
        backup_url = Path(backup_url_file).read_text().strip() if backup_url_file else cfg['database']['url']
        with postgres_environment(backup_url, backup) as env, open(partial, 'xb') as output:
            os.chmod(output.name, 0o600)
            run(['pg_dump', '--no-owner', '--no-password'], env=env, output=output,
                error_file=backup / 'pg_dump.stderr.log')
        os.replace(partial, backup / 'database.sql')
    return backup

def activate_link(base, release):
    temp = base / 'next'
    if temp.exists() or temp.is_symlink():
        temp.unlink()
    temp.symlink_to(release)
    os.replace(temp, base / 'current')

def validate_resume(base, release):
    # Resume only a staged first installation, never an update or a different release.
    if (base / 'state.json').exists():
        raise DeployError('cli.exists')
    if not release.is_dir() or release.is_symlink() or not (release / '.git').is_dir():
        fail('resume_staged_release_missing')
    current = base / 'current'
    if current.exists() or current.is_symlink():
        if not current.is_symlink() or current.resolve() != release.resolve():
            fail('resume_current_revision_mismatch')
    if base.name == 'identity':
        if not (base / 'config.json').is_file() or not (base / 'identity.env').is_file():
            fail('resume_identity_secrets_missing')
        if (base / 'identity.env').is_symlink():
            fail('resume_identity_secrets_symlink')

def stage_runtime_secrets(base, cfg, info):
    directory = base / 'secrets'
    safe_root(str(directory))
    directory.mkdir(mode=0o750, exist_ok=True)
    directory.chmod(0o750)
    shutil.chown(directory, 0, info.pw_gid)
    def copy(source, name):
        target = directory / name
        if target.is_symlink():
            fail('secret_symlink')
        if Path(source).resolve() != target.resolve():
            shutil.copyfile(source, target)
        os.chmod(target, 0o640)
        shutil.chown(target, 0, info.pw_gid)
        return str(target)
    if base.name == 'gateway':
        cfg['oidc']['clientSecretFile'] = copy(cfg['oidc']['clientSecretFile'], 'oidc-client.secret')
        cfg['delegation']['privateKeyFile'] = copy(cfg['delegation']['privateKeyFile'], 'delegation.key')
    elif cfg.get('delegation'):
        keys = cfg['delegation']['publicKeys']
        for kid, source in list(keys.items()):
            if not re.fullmatch(r'[a-zA-Z0-9_-]{1,64}', kid):
                fail('delegation.key_id')
            keys[kid] = copy(source, 'public-' + kid + '.pem')

def deployment_directory(path):
    # Bootstrap intentionally uses umask 077. Service ancestors still need traversal.
    path.mkdir(mode=0o755, parents=True, exist_ok=True)
    path.chmod(0o755)

def archive_staged_update(base, release, existing):
    # A failed update may have already applied additive migrations. Keep its
    # source/diagnostics for inspection and retry with a clean build directory.
    # Never move a directory referenced by the installed state/current link.
    current = base / 'current'
    if (release.is_symlink() or not release.is_dir() or
        Path(existing['release']).resolve() == release.resolve() or
        ((current.exists() or current.is_symlink()) and current.resolve() == release.resolve())):
        fail('release_exists')
    archive = base / 'failed-releases'
    safe_root(str(archive))
    archive.mkdir(mode=0o700, exist_ok=True)
    destination = archive / (release.name + '-' + str(time.time_ns()))
    os.rename(release, destination)
    shutil.chown(destination, 0, 0)
    destination.chmod(0o700)
    emit('cli.updateArchived', path=str(destination))

def deploy(args):
    if args.component not in COMPONENTS:
        fail('component')
    root = Path(args.root)
    base = root / args.component
    existing = read_json(base / 'state.json') if (base / 'state.json').exists() else None
    if args.action == 'status':
        if not existing:
            if (base / 'config.json').exists() or (base / 'releases').is_dir():
                raise DeployError('cli.incomplete')
            raise DeployError('cli.missing')
        cfg = validate_config(args.component, read_json(base / 'config.json'))
        ready = True
        try:
            health(base, cfg, Path(existing['release']))
        except Exception:
            ready = False
        emit('cli.status', component=args.component, revision=existing['revision'], ready=ready)
        return 0 if ready else 1
    if args.action == 'install' and existing:
        raise DeployError('cli.exists')
    if args.action == 'resume' and existing:
        raise DeployError('cli.exists')
    if args.action == 'update' and not existing:
        raise DeployError('cli.missing')
    if args.action == 'update' and args.config:
        fail('update_preserves_existing_config')
    stored_config = args.action == 'resume' and (base / 'config.json').exists()
    cfg_path = base / 'config.json' if existing or stored_config else Path(args.config or '')
    cfg = validate_config(args.component, read_json(cfg_path))
    repo = repository(args.repository)
    if not re.fullmatch(r'[a-f0-9]{40}', args.revision or ''):
        fail('full_commit_sha_required')
    if args.action == 'resume':
        validate_resume(base, base / 'releases' / args.revision)
    if not args.apply:
        emit('cli.plan', component=args.component, revision=args.revision, publicOrigin=cfg['publicOrigin'], port=cfg['listen']['port'])
        return 0
    root = safe_root(args.root)
    safe_root(str(root / args.component))
    preflight(args.component, base, cfg)
    deployment_directory(root)
    deployment_directory(base)
    with open(base / 'operation.lock', 'a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise DeployError('cli.locked')
        # Recheck under the lock; two installers must not overwrite a freshly created config.
        if args.action == 'install' and ((base / 'config.json').exists() or (base / 'state.json').exists()):
            raise DeployError('cli.exists')
        if args.action == 'resume':
            validate_resume(base, base / 'releases' / args.revision)
            if stored_config:
                cfg = validate_config(args.component, read_json(base / 'config.json'))
        if existing and read_json(base / 'state.json') != existing:
            fail('state_changed')
        release = base / 'releases' / args.revision
        if release.exists() or release.is_symlink():
            if args.action == 'update':
                archive_staged_update(base, release, existing)
            elif args.action != 'resume':
                fail('release_exists')
        deployment_directory(release.parent)
        try:
            if args.action == 'resume':
                emit('cli.resuming', component=args.component, revision=args.revision)
                # An interrupted unprivileged build may still own the staged checkout.
                run(['chown', '-R', 'root:root', str(release)])
                run(['git', '-C', str(release), 'diff', '--quiet', 'HEAD', '--'])
                run(['git', '-C', str(release), 'diff', '--cached', '--quiet', 'HEAD', '--'])
            else:
                run(['git', 'clone', '--no-checkout', '--', repo, str(release)])
                run(['git', '-C', str(release), 'checkout', '--detach', args.revision])
            if run(['git', '-C', str(release), 'rev-parse', 'HEAD']) != args.revision:
                fail('revision_mismatch')
            release_meta = read_json(release / 'deploy/release.json')
            protocol = release_meta.get('protocol')
            entries = release_meta.get('migrations')
            if protocol not in (1, PROTOCOL) or not isinstance(entries, list) or (protocol == 1 and entries):
                fail('unsupported_migration_or_protocol')
            selected_migrations = [m for m in entries if isinstance(m, dict) and m.get('component') == args.component]
            if selected_migrations:
                for key in ('runtimeRole', 'backupRole'):
                    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', cfg['database'].get(key, '')):
                        fail('database.' + key)
                for key in ('migrationUrlFile', 'backupUrlFile'):
                    path = Path(cfg['database'].get(key, ''))
                    if not path.is_absolute() or not path.is_file() or path.is_symlink() or path.stat().st_uid != 0 or path.stat().st_mode & 0o077:
                        fail('database.' + key)
                if any(not m.get('backwardCompatible') for m in selected_migrations):
                    fail('migration_requires_reviewed_runbook')
            if args.component != 'identity':
                info = ensure_user(base)
                for directory in (release, base / 'data'):
                    directory.mkdir(mode=0o700, exist_ok=True)
                    shutil.chown(directory, info.pw_uid, info.pw_gid)
                # Build unprivileged. Reset ownership afterwards so runtime cannot rewrite releases.
                run(['chown', '-R', str(info.pw_uid) + ':' + str(info.pw_gid), str(release)])
                build_env = {**os.environ, 'npm_config_cache': str(base / 'data/npm-cache'), 'HOME': str(base / 'data')}
                run(['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], cwd=release, env=build_env, user=info.pw_name)
                run(['npm', 'run', 'build'], cwd=release, env=build_env, user=info.pw_name)
                run(['chown', '-R', 'root:' + info.pw_name, str(release)])
                run(['chmod', '-R', 'u=rwX,g=rX,o=', str(release)])
            if args.component == 'identity' and existing:
                # authentik performs its own migrations; do not silently roll provider versions back.
                old_compose = Path(existing['release']) / 'apps/identity/compose.yaml'
                image_lines = lambda p: [line.strip() for line in p.read_text().splitlines() if line.strip().startswith('image:')]
                if image_lines(old_compose) != image_lines(release / 'apps/identity/compose.yaml'):
                    fail('provider_image_upgrade_requires_reviewed_runbook')
            if not existing and not stored_config:
                if args.component != 'identity':
                    tls_dir = base / 'tls'
                    safe_root(str(tls_dir))
                    tls_dir.mkdir(mode=0o750, exist_ok=True)
                    tls_dir.chmod(0o750)
                    shutil.chown(tls_dir, 0, info.pw_gid)
                    for key in ('certFile', 'keyFile', 'caFile'):
                        target = tls_dir / key
                        shutil.copyfile(cfg['listen']['tls'][key], target)
                        os.chmod(target, 0o640)
                        shutil.chown(target, 0, info.pw_gid)
                        cfg['listen']['tls'][key] = str(target)
                    cfg['worker']['heartbeatFile'] = str(base / 'data/worker.json')
                atomic_json(base / 'config.json', cfg)
                if args.component != 'identity':
                    shutil.chown(base / 'config.json', 0, info.pw_gid)
                    os.chmod(base / 'config.json', 0o640)
                else:
                    address = cfg['listen']['address']
                    if ':' in address:
                        address = '[' + address + ']'
                    fd = os.open(base / 'identity.env', os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                    with os.fdopen(fd, 'w') as out:
                        out.write('PG_PASS=' + secrets.token_hex(32) + '\nAUTHENTIK_SECRET_KEY=' + secrets.token_hex(48) + '\nBIND_ADDRESS=' + address + '\nHTTPS_PORT=' + str(cfg['listen']['port']) + '\n')
            checkpoint(base, cfg, existing)
            if args.component != 'identity':
                stage_runtime_secrets(base, cfg, info)
                atomic_json(base / 'config.json', cfg, 0o640)
                os.chmod(base / 'config.json', 0o640)
                shutil.chown(base / 'config.json', 0, info.pw_gid)
                if selected_migrations:
                    run([shutil.which('node'), str(release / 'dist/server/scripts/migrate.js'), args.component],
                        cwd=release, env={**os.environ, 'APP_CONFIG': str(base / 'config.json')})
            if args.component == 'identity':
                run(compose(base, release) + ['config', '--quiet'])
                if args.action != 'resume':
                    run(compose(base, release) + ['pull'])
            activate_link(base, release)
            if args.component == 'identity':
                run(compose(base, release) + ['up', '-d', '--wait', '--wait-timeout', '540'])
            else:
                node = shutil.which('node')
                if not node or not re.fullmatch(r'/[A-Za-z0-9_./-]+', node):
                    fail('node_path')
                for worker in (False, True):
                    (Path('/etc/systemd/system') / unit_name(base, worker)).write_text(render_unit(base, node, worker))
                run(['systemctl', 'daemon-reload'])
                for worker in (False, True):
                    run(['systemctl', 'enable', unit_name(base, worker)])
                    run(['systemctl', 'restart', unit_name(base, worker)])
            for attempt in range(20):
                try:
                    health(base, cfg, release)
                    break
                except Exception:
                    if attempt == 19:
                        raise
                    time.sleep(2)
            atomic_json(base / 'state.json', {'revision': args.revision, 'version': release_meta['version'], 'protocol': release_meta['protocol'], 'release': str(release)})
            emit('cli.installed', component=args.component, revision=args.revision)
            return 0
        except Exception as error:
            if existing and (base / 'current').is_symlink() and (base / 'current').resolve() == release:
                activate_link(base, Path(existing['release']))
                try:
                    if args.component == 'identity':
                        run(compose(base, Path(existing['release'])) + ['up', '-d'])
                    else:
                        for worker in (False, True):
                            run(['systemctl', 'restart', unit_name(base, worker)])
                    health(base, cfg, Path(existing['release']))
                    emit('cli.recovery', component=args.component)
                except Exception:
                    raise DeployError('cli.failedRecovery')
            if isinstance(error, DeployError):
                raise
            raise DeployError('cli.failed')

class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise DeployError('cli.arguments')

def main(argv=None):
    parser = Parser(add_help=False)
    parser.add_argument('action', choices=('install', 'update', 'status', 'resume'))
    parser.add_argument('--component', choices=COMPONENTS, required=True)
    parser.add_argument('--root', required=True)
    parser.add_argument('--config')
    parser.add_argument('--repository', default='https://github.com/CoyWorks/Pactaris.git')
    parser.add_argument('--revision')
    parser.add_argument('--apply', action='store_true')
    argsv = list(sys.argv[1:] if argv is None else argv)
    if '--help' in argsv:
        emit('cli.help')
        return 0
    try:
        return deploy(parser.parse_args(argsv))
    except KeyboardInterrupt:
        emit('cli.interrupted')
        return 130
    except DeployError as e:
        emit(e.key, **e.params)
        return 1
    except Exception:
        emit('cli.failed')
        return 1

if __name__ == '__main__':
    sys.exit(main())
