# Security

This repository contains an alpha hosted service that is deployed for an invite-only pilot. No production release or security support SLA is declared.

Do not post credentials, household content, identifying screenshots, token-bearing links or exploitation details in public issues.

Use GitHub's private vulnerability reporting option if it is enabled for this repository. If it is unavailable, contact the maintainer through an independently verified private channel to arrange disclosure. A dedicated reporting address and incident owner must be established before public onboarding; see issues #32 and #33. This document does not claim that private reporting has been enabled.

Reports should identify the affected version, the smallest synthetic reproduction and the access/consent boundary involved. Avoid using real people's records to demonstrate a problem.

Implemented controls include independent sessions, tenant/resource authorization, PostgreSQL RLS, explicit consent, pause/stop, transactional audit/outbox, personal export, account deletion, MFA-gated operator access and encrypted backups with fenced restore. They are verified by automated tests; public-launch security acceptance (#31) and an independent review are still open, so none of this is a guarantee.
