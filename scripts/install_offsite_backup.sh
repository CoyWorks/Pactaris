#!/usr/bin/env bash
set -euo pipefail

# Installs the off-host backup units. It does not enable the timer or create a target:
# add /etc/pactaris/offsite-backup.json first (docs/RECOVERY.md).
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install -d -m 0755 /usr/local/lib/pactaris
install -o root -g root -m 0644 "$source_dir/scripts/offsite_backup.py" /usr/local/lib/pactaris/offsite_backup.py
for extension in service timer; do
    unit="pactaris-offsite-backup.$extension"
    install -o root -g root -m 0644 "$source_dir/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
systemctl daemon-reload
