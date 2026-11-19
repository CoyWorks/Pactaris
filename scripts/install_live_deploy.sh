#!/usr/bin/env bash
set -euo pipefail

source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install -d -m 0755 /usr/local/lib/pactaris
install -o root -g root -m 0644 "$source_dir/scripts/live_deploy.py" /usr/local/lib/pactaris/live_deploy.py
for extension in service timer; do
    unit="pactaris-live-deploy.$extension"
    install -o root -g root -m 0644 "$source_dir/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
