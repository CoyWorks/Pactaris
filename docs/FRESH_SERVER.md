# Fresh main server — experimental foundation

Target: an empty Ubuntu 24.04 or 26.04 LTS systemd server, amd64 or arm64. Run the blocks in order as root in one SSH session. Stop on any error. This provisions the foundation for a test deployment, not a working production login/household service. Privileged installation has not yet been verified on an OCI host; see [verification limits](DEVELOPMENT.md).

## 1. OS and CloudPanel

```bash
sudo -i
cat /etc/os-release
apt update
apt -y upgrade
apt install -y curl wget sudo ca-certificates gnupg git nano openssl python3 build-essential
```

If a reboot is required, reboot and reconnect before continuing. Install CloudPanel **before** provisioning the application runtimes. Skip this installer when CloudPanel already exists. On a separate internal Instance host, skip CloudPanel entirely.

```bash
cd /root
curl -fsSL https://installer.cloudpanel.io/ce/v2/install.sh -o cloudpanel-install.sh
echo '8146dbe0a488e7088b04071b0c34d59aa0ab1fe9dcec382d395fd155c9e6c476 cloudpanel-install.sh' | sha256sum -c - && DB_ENGINE=MYSQL_8.4 bash cloudpanel-install.sh
```

The checksum was checked against the official instructions on 2026-11-16. If it differs, stop and compare the current official installer/checksum; do not bypass verification. Create the CloudPanel administrator at `https://SERVER_IP:8443` and restrict access to the management port to your management network. CloudPanel's MySQL is separate from Pactaris PostgreSQL.

## 2. System-wide Node.js 24

```bash
install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /root/nodesource.asc
gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg /root/nodesource.asc
chmod 0644 /etc/apt/keyrings/nodesource.gpg
cat > /etc/apt/sources.list.d/nodesource.sources <<'EOF'
Types: deb
URIs: https://deb.nodesource.com/node_24.x/
Suites: nodistro
Components: main
Signed-By: /etc/apt/keyrings/nodesource.gpg
EOF
apt update
apt install -y nodejs
/usr/bin/node --version
npm --version
```

Node must report `v24.x`; do not use a runtime installed inside a private user's home directory.

## 3. Docker Engine and Compose for Identity

```bash
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt update
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
docker compose version
```

## 4. PostgreSQL for Instance

Identity gets its own private PostgreSQL container. Instance uses the host PostgreSQL service in this first colocated deployment. Neither database port needs public ingress.

```bash
apt install -y postgresql postgresql-client
systemctl enable --now postgresql
pg_isready -h 127.0.0.1 -p 5432
```

## 5. Source checkout and protected configuration

```bash
git clone https://github.com/CoyWorks/Pactaris.git /opt/pactaris-source
cd /opt/pactaris-source
REVISION="$(git rev-parse HEAD)"
git show --no-patch --oneline "$REVISION"
```

Inspect and approve that commit before continuing. Set `REVISION` to a reviewed full commit SHA and `git checkout --detach "$REVISION"` if selecting another release. Installers subsequently fetch exactly this SHA, not a moving branch. Private repository access later requires an operator-provisioned read-only deploy key; never embed a token in a URL.

```bash
umask 077
install -d -m 0700 /etc/pactaris/bootstrap
cp -n config/identity.example.json /etc/pactaris/bootstrap/identity.json
cp -n config/instance.example.json /etc/pactaris/bootstrap/instance.json
```

The following block is **first installation only**. It refuses to replace configuration already containing a real database credential. It creates a non-superuser runtime account and an empty database. No tenant tables/migrations exist yet; future migrations must use separate migration credentials and explicit grants.

```bash
python3 - <<'PY'
import json, secrets, subprocess, uuid
from pathlib import Path
folder = Path('/etc/pactaris/bootstrap')
instance = json.loads((folder / 'instance.json').read_text())
if 'REPLACE' not in instance['database']['url']:
    raise SystemExit('Configuration already initialized; preserve the existing credentials.')
password = secrets.token_hex(32)
sql = f"""CREATE ROLE pactaris_instance LOGIN PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE pactaris_instance OWNER postgres;
REVOKE ALL ON DATABASE pactaris_instance FROM PUBLIC;
GRANT CONNECT ON DATABASE pactaris_instance TO pactaris_instance;
"""
subprocess.run(['runuser', '-u', 'postgres', '--', 'psql', '-v', 'ON_ERROR_STOP=1'], input=sql, text=True, check=True, stdout=subprocess.DEVNULL)
instance['instanceId'] = str(uuid.uuid4())
instance['publicOrigin'] = 'https://instance1.coyworks.nl'
instance['database']['url'] = f'postgresql://pactaris_instance:{password}@127.0.0.1:5432/pactaris_instance'
instance['listen']['tls'] = {
    'certFile': str(folder / 'instance.crt'),
    'keyFile': str(folder / 'instance.key'),
    'caFile': str(folder / 'ca.crt'),
    'serverName': 'instance1.coyworks.nl'
}
(folder / 'instance.json').write_text(json.dumps(instance, indent=2) + '\n')
identity = json.loads((folder / 'identity.json').read_text())
identity['publicOrigin'] = 'https://identity.coyworks.nl'
(folder / 'identity.json').write_text(json.dumps(identity, indent=2) + '\n')
PY
chmod 0600 /etc/pactaris/bootstrap/*.json
```

These example origins are configuration values: edit both JSON files if using different domains. Keep loopback binds when CloudPanel is on this host. A split host requires private listen addresses, firewall rules and independently verified backend TLS.

## 6. Instance backend TLS

For this isolated test setup, create an internal CA and a certificate matching the configured backend server name. Adapt the DNS SAN/name below when changing the domain. Retain the CA private key securely; only its public certificate belongs on the proxy. Use managed PKI and renewals for production.

```bash
cd /etc/pactaris/bootstrap
openssl req -x509 -newkey rsa:3072 -noenc -sha256 -days 3650 \
  -keyout ca.key -out ca.crt -subj '/CN=Pactaris Internal CA' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,keyCertSign,cRLSign'
openssl req -new -newkey rsa:3072 -noenc -sha256 \
  -keyout instance.key -out instance.csr -subj '/CN=instance1.coyworks.nl'
cat > instance.ext <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:instance1.coyworks.nl,IP:127.0.0.1
EOF
openssl x509 -req -in instance.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out instance.crt -days 365 -sha256 -extfile instance.ext
openssl verify -CAfile ca.crt -verify_hostname instance1.coyworks.nl instance.crt
chmod 0600 ca.key instance.key
```

Do not rerun these certificate-generation commands over an existing deployment. The installer copies the initial Instance certificate/key/CA to protected component storage.

## 7. Plan, install, check

```bash
cd /opt/pactaris-source
bash install.sh --component identity --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/identity.json --revision "$REVISION"
bash install.sh --component instance --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/instance.json --revision "$REVISION"
```

Review both plans, then apply:

```bash
bash install.sh --component identity --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/identity.json --revision "$REVISION" --apply
bash status.sh --component identity --root /opt/pactaris
bash install.sh --component instance --root /opt/pactaris \
  --config /etc/pactaris/bootstrap/instance.json --revision "$REVISION" --apply
bash status.sh --component instance --root /opt/pactaris
curl --cacert /etc/pactaris/bootstrap/ca.crt \
  --resolve instance1.coyworks.nl:9444:127.0.0.1 \
  https://instance1.coyworks.nl:9444/health/ready
systemctl list-units --all 'pactaris-instance-*.service'
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
```

Both status commands should report `ready: true`; Instance readiness should return HTTP 200. This proves local foundation health, not login, tenant isolation or external ingress. If first installation fails, stop and inspect the retained configuration/staged release. Automatic resume/repair is not implemented. Do not remove volumes, overwrite credentials or delete state to retry.

## 8. CloudPanel ingress and remaining Identity setup

| Public origin | Private HTTPS backend |
| --- | --- |
| `https://identity.coyworks.nl` | `https://127.0.0.1:9443` |
| `https://instance1.coyworks.nl` | `https://127.0.0.1:9444` |

Create the two reverse-proxy sites and public certificates in CloudPanel. Configure trusted backend certificates, explicit backend names/SNI and verification. Instance uses the CA above. Identity initially uses the provider's default certificate: configure a certificate for its own backend name and the proxy trust before accepting it through public ingress. Never turn verification off to get past this step. Provider admin initialization, branding, SMTP, local enrollment, OIDC clients and Google/Apple sources remain manual and are not implemented as Pactaris bootstrap automation yet. Follow the provider runbook; do not expose an unclaimed initial-admin setup publicly.

Allow public 80/443 for ingress and your approved management access for SSH/8443 in both OCI and host policy. Keep 5432, 9443 and 9444 private. Configure DNS records for both public origins. A separate proxy must reach private server addresses rather than loopback; a remote instance's backend DNS must not resolve back to the public proxy.

## Naming and upgrades

Product name: **Pactaris**. Deployment roots: `/opt/pactaris/identity` and `/opt/pactaris/instance`; bootstrap configuration: `/etc/pactaris/bootstrap`. Docker project names start `pactaris-identity-`; systemd units/users start `pactaris-instance-`, with a stable path-derived suffix to prevent deployment collisions. Actual Instance runtime is systemd, not a Docker container.

This naming update targets new installations. An older installed prefix/path requires an explicit migration preserving service users, ownership, state, Compose project identity and volumes; changing a prefix is not a data migration.

## Upstream references

Checked 2026-11-16:

- [CloudPanel fresh-server instructions](https://www.cloudpanel.io/docs/v2/getting-started/other/)
- [Docker Ubuntu apt repository](https://docs.docker.com/engine/install/ubuntu/)
- [NodeSource manual repository setup](https://github.com/nodesource/distributions/wiki/Repository-Manual-Installation)
- [PostgreSQL Ubuntu packages](https://www.postgresql.org/download/linux/ubuntu/)
