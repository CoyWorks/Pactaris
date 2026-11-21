#!/usr/bin/env bash
set -euo pipefail

# Installs the housekeeping units and a journald size limit. It does not enable the timer:
# run a dry run first (docs/MAINTENANCE.md), then enable it.
source_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
install -d -m 0755 /usr/local/lib/pactaris
install -o root -g root -m 0644 "$source_dir/scripts/housekeeping.py" /usr/local/lib/pactaris/housekeeping.py
for extension in service timer; do
    unit="pactaris-housekeeping.$extension"
    install -o root -g root -m 0644 "$source_dir/deploy/systemd/$unit" "/etc/systemd/system/$unit"
done
install -d -m 0755 /etc/systemd/journald.conf.d
install -o root -g root -m 0644 "$source_dir/deploy/systemd/journald-pactaris.conf" /etc/systemd/journald.conf.d/pactaris.conf
systemctl daemon-reload
systemctl restart systemd-journald
