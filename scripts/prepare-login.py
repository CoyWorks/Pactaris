#!/usr/bin/env python3
"""Explicit, non-destructive bootstrap for the existing co-located alpha installation."""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import time
from urllib.parse import quote, unquote, urlsplit
from uuid import uuid4
from deploy import SOURCE, DeployError, atomic_json, compose, deployment_directory, emit, fail, public_origin, read_json, run, safe_root

def psql(sql, database='postgres'):
    result = subprocess.run(['runuser','-u','postgres','--','psql','-X','-q','-t','-A','-v','ON_ERROR_STOP=1','-d',database],
                            input=sql,text=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=30)
    if result.returncode:
        fail('login.database_provisioning')
    return result.stdout.strip()

def identifier(value):
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', value):
        fail('login.database_identifier')
    return '"'+value+'"'

def private_text(path, value):
    fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as stream:
        stream.write(value+'\n')

def provision_role(folder, name, database, backup=False):
    identifier(name); identifier(database)
    path=folder/(name+'.url')
    exists=psql("SELECT 1 FROM pg_roles WHERE rolname='"+name+"'")=='1'
    if path.exists():
        if path.is_symlink() or path.stat().st_mode & 0o077:
            fail('login.private_credential')
        url=urlsplit(path.read_text().strip())
        if url.username!=name or unquote(url.path[1:])!=database or not url.password:
            fail('login.credential_mismatch')
        password=unquote(url.password)
        # Stored credentials belong to this setup; do not rotate an existing role.
    else:
        if exists:
            fail('login.existing_role_without_credentials')
        password=secrets.token_hex(32)
        private_text(path,f'postgresql://{name}:{password}@127.0.0.1:5432/{quote(database,safe="")}')
    if not exists:
        # Generated/stored hex only, passed through stdin rather than process arguments.
        if not re.fullmatch(r'[a-f0-9]{64}',password):
            fail('login.stored_password_format')
        psql(f"CREATE ROLE {identifier(name)} LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE {'BYPASSRLS' if backup else 'NOBYPASSRLS'};")
    flags=json.loads(psql(f"SELECT json_build_array(rolsuper,rolcreatedb,rolcreaterole,rolbypassrls,rolreplication) FROM pg_roles WHERE rolname='{name}'"))
    if flags != [False,False,False,backup,False]:
        fail('login.role_privileges')
    return str(path)

def main():
    parser=argparse.ArgumentParser(add_help=False)
    parser.add_argument('--root',default='/opt/pactaris')
    parser.add_argument('--public-origin',default=json.loads((SOURCE/'config/gateway.example.json').read_text())['publicOrigin'])
    parser.add_argument('--provider',default='Pactaris-Instance1-OIDC')
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    origin=public_origin(args.public_origin)
    root=Path(args.root)
    if not args.apply:
        emit('cli.loginPlan',publicOrigin=origin)
        return 0
    if os.geteuid()!=0:
        fail('root_required_for_apply')
    safe_root(str(root))
    identity=root/'identity';instance=root/'instance';gateway=root/'gateway'
    identity_config=read_json(identity/'config.json'); cfg=read_json(instance/'config.json')
    identity_state=read_json(identity/'state.json');read_json(instance/'state.json')
    dburl=urlsplit(cfg['database']['url'])
    if dburl.hostname!='127.0.0.1' or (dburl.port or 5432)!=5432:
        fail('login_requires_local_postgresql')
    database=unquote(dburl.path[1:]);runtime=unquote(dburl.username or '')
    identifier(database);identifier(runtime)
    bootstrap=Path('/etc/pactaris/bootstrap');folder=bootstrap/'login'
    folder.mkdir(mode=0o700,parents=True,exist_ok=True)
    if folder.is_symlink() or folder.stat().st_uid!=0 or folder.stat().st_mode & 0o077:
        fail('login.bootstrap_permissions')
    gateway_config=bootstrap/'gateway.json'
    if gateway_config.exists():
        existing=read_json(gateway_config)
        if existing['publicOrigin']!=origin:
            fail('login_origin_change_requires_migration')
    else:
        existing=None
    deployment_directory(gateway)
    with contextlib.ExitStack() as stack:
        for base in (instance,gateway):
            lock=stack.enter_context(open(base/'operation.lock','a'))
            try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError: raise DeployError('cli.locked')
        metadata_code="""import json
from authentik.providers.oauth2.models import OAuth2Provider
p=OAuth2Provider.objects.get(name=%r)
print('PACTARIS_METADATA='+json.dumps({'clientId':p.client_id,'secret':p.client_secret,'slug':p.application.slug}))
""" % args.provider
        output=run(compose(identity,Path(identity_state['release']))+['exec','-T','worker','ak','shell','-c',metadata_code])
        records=[line[len('PACTARIS_METADATA='):] for line in output.splitlines() if line.startswith('PACTARIS_METADATA=')]
        if len(records)!=1: fail('login.provider_metadata')
        metadata=json.loads(records[0])
        if not metadata['secret'] or not re.fullmatch(r'[-a-zA-Z0-9_]+',metadata['slug']): fail('login.provider_metadata')
        secret_path=bootstrap/'instance1-oidc.secret'
        if secret_path.exists():
            if secret_path.is_symlink() or secret_path.stat().st_uid!=0 or secret_path.stat().st_mode & 0o077: fail('login.private_credential')
            if secret_path.read_text().strip()!=metadata['secret']: fail('login.client_secret_mismatch')
        else: private_text(secret_path,metadata['secret'])
        if psql("SELECT 1 FROM pg_database WHERE datname='pactaris_gateway'")=='1' and not existing and not (folder/'pactaris_gateway_runtime.url').exists():
            fail('login.existing_database_without_configuration')
        # Provision credentials once. A retry uses the same protected credential files.
        for name,backup in [('pactaris_gateway_runtime',False),('pactaris_gateway_migrator',False),('pactaris_gateway_backup',True)]:
            provision_role(folder,name,'pactaris_gateway',backup)
        if psql("SELECT 1 FROM pg_database WHERE datname='pactaris_gateway'")!='1':
            psql('CREATE DATABASE pactaris_gateway OWNER postgres;')
        psql('REVOKE ALL ON DATABASE pactaris_gateway FROM PUBLIC; GRANT CONNECT ON DATABASE pactaris_gateway TO pactaris_gateway_runtime,pactaris_gateway_migrator,pactaris_gateway_backup; GRANT CREATE ON DATABASE pactaris_gateway TO pactaris_gateway_migrator;')
        migrator=provision_role(folder,'pactaris_instance_migrator',database)
        backup=provision_role(folder,'pactaris_instance_backup',database,True)
        psql(f'GRANT CONNECT ON DATABASE {identifier(database)} TO pactaris_instance_migrator,pactaris_instance_backup; GRANT CREATE ON DATABASE {identifier(database)} TO pactaris_instance_migrator;')
        ca=bootstrap/'ca.crt';ca_key=bootstrap/'ca.key'
        for p in (ca,ca_key):
            if not p.is_file(): fail('login.internal_ca_required')
        private=folder/'delegation.key';public=folder/'delegation.pub'
        if not private.exists(): run(['openssl','genpkey','-algorithm','Ed25519','-out',str(private)])
        os.chmod(private,0o600)
        if not public.exists(): run(['openssl','pkey','-in',str(private),'-pubout','-out',str(public)])
        leaf=folder/'gateway.crt';key=folder/'gateway.key'
        hostname=urlsplit(origin).hostname
        if not re.fullmatch(r'[a-zA-Z0-9.-]+',hostname or ''): fail('login.hostname')
        if not leaf.exists():
            if key.exists(): fail('login.partial_tls_requires_review')
            run(['openssl','req','-new','-newkey','rsa:3072','-noenc','-sha256','-keyout',str(key),'-out',str(folder/'gateway.csr'),'-subj','/CN='+hostname])
            os.chmod(key,0o600)
            (folder/'gateway.ext').write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:'+hostname+'\n')
            run(['openssl','x509','-req','-in',str(folder/'gateway.csr'),'-CA',str(ca),'-CAkey',str(ca_key),'-CAcreateserial','-out',str(leaf),'-days','365','-sha256','-extfile',str(folder/'gateway.ext')])
        run(['openssl','verify','-CAfile',str(ca),'-verify_hostname',hostname,str(leaf)])
        gateway_cfg=existing or json.loads((SOURCE/'config/gateway.example.json').read_text())
        if not existing: gateway_cfg['gatewayId']=str(uuid4())
        gateway_cfg['publicOrigin']=origin
        gateway_cfg['listen']['tls']={'certFile':str(leaf),'keyFile':str(key),'caFile':str(ca),'serverName':hostname}
        gateway_cfg['database']['url']=(folder/'pactaris_gateway_runtime.url').read_text().strip()
        gateway_cfg['database'].update(runtimeRole='pactaris_gateway_runtime',migrationUrlFile=str(folder/'pactaris_gateway_migrator.url'),backupRole='pactaris_gateway_backup',backupUrlFile=str(folder/'pactaris_gateway_backup.url'))
        gateway_cfg['oidc']={'issuer':identity_config['publicOrigin'].rstrip('/')+'/application/o/'+metadata['slug']+'/', 'clientId':metadata['clientId'],'clientSecretFile':str(secret_path)}
        gateway_cfg['delegation']={'keyId':'gateway-v1','privateKeyFile':str(private)}
        gateway_cfg['worker']['heartbeatFile']=str(gateway/'data/worker.json')
        atomic_json(gateway_config,gateway_cfg)
        # Preserve an explicit pre-change copy before adding only login/migration settings.
        checkpoint=instance/'backups'/('login-config-'+str(time.time_ns()));checkpoint.mkdir(mode=0o700,parents=True)
        shutil.copy2(instance/'config.json',checkpoint/'config.json')
        cfg['database'].update(runtimeRole=runtime,migrationUrlFile=migrator,backupRole='pactaris_instance_backup',backupUrlFile=backup)
        trust=instance/'trust';safe_root(str(trust));trust.mkdir(mode=0o755,exist_ok=True);trust.chmod(0o755)
        shutil.copyfile(public,trust/'gateway.pub');os.chmod(trust/'gateway.pub',0o644)
        cfg['delegation']={'issuer':origin,'publicKeys':{'gateway-v1':str(trust/'gateway.pub')}}
        group=(instance/'config.json').stat().st_gid
        atomic_json(instance/'config.json',cfg,0o640);os.chmod(instance/'config.json',0o640);os.chown(instance/'config.json',0,group)
        # Add the exact new callback while keeping the old test callback for controlled cutover.
        update_code="""from authentik.providers.oauth2.models import OAuth2Provider
p=OAuth2Provider.objects.get(name=%r)
uri={'matching_mode':'strict','redirect_uri_type':'authorization','url':%r}
if uri not in p._redirect_uris:
    p._redirect_uris=[*p._redirect_uris,uri]
    p.save(update_fields=['_redirect_uris'])
a=p.application
a.name='Pactaris'
a.meta_launch_url=%r
a.save(update_fields=['name','meta_launch_url'])
""" % (args.provider,origin+'/auth/oidc/callback',origin+'/')
        run(compose(identity,Path(identity_state['release']))+['exec','-T','worker','ak','shell','-c',update_code])
        emit('cli.loginPrepared',path=str(gateway_config),publicOrigin=origin)
        return 0

if __name__=='__main__':
    try: sys.exit(main())
    except DeployError as error: emit(error.key,**error.params);sys.exit(1)
    except Exception: emit('cli.failed');sys.exit(1)
