# First six P0 delivery blocks

**Feature-order override — 17 November 2026:** the owner requested everyday basics first. Follow [EARLY_VERSION_BASICS.md](EARLY_VERSION_BASICS.md): owner-only household workspace/settings and basic tasks (#15/#27/#17), then the rules library and notes. The table below records prior delivery history; it is no longer the next feature execution order. Keep existing safety/privacy boundaries and broader release gates.

Approved execution order for a closed alpha with a small invited test group. Tracking: #68. This plan does not declare the broader parent issues complete.

The alpha goal is sign in, create a private dynamic, invite a partner, explicitly agree on relationships/scope, perform a task, pause/stop and leave. These six P0 blocks establish participation, permission and safety before task execution. Tasks/dashboard/PWA and the release operations/privacy gates remain separate required alpha work.

| Order | Issues | Deliverable | Current state |
| --- | --- | --- | --- |
| 1 | #70 | Membership identity/history; delayed command, receipt and hint fencing | Implemented in 0.3.2-alpha.1; CI and rollout evidence recorded in #70 |
| 2 | #8, #53 | Explicit invitation create/preview/accept/decline/revoke; verified recipient and atomic member reservations | Participant invitation workflow implemented in 0.4.0-alpha.1; real IdP/mobile acceptance remains |
| 3 | #26 | Immediate departure/removal, voluntary ownership transfer and lifecycle/privacy cleanup | Member removal, voluntary ownership, aliases and local revocation cleanup implemented in 0.5.0-alpha.1; account-wide deletion/export/retention and restore gates remain open |
| 4 | #35, #9 | Explicit accepted relationship graph and contextual roles; resource authorization separate from labels | Private immutable proposals, individual accept/decline/withdraw and contextual roles implemented in 0.6.0-alpha.1; wider sharing, profile labels and activity consent remain open |
| 5 | #10, #11 | Exact-version individual consent, limits, revocation and authoritative pause/stop | Versioned agreements/private limits, transactional activity guard, personal/relationship pauses, all-member household re-entry and bounded restrictive outage grants implemented in 0.7.0-alpha.1; effectful queue/task integration and wider failover remain gates |
| 6 | #6, #7, #24 | Verified registration/recovery, MFA/session controls and transactional delivery; real Google/Apple/local acceptance | OIDC/session/email assertion foundations exist; provider/operational acceptance remains |

## Small delivery steps

Each block is split into reviewed migrations/domain operations, public API/mobile forms and failure/authorization acceptance. Publish working checkpoints with evidence; do not close a broad issue because a schema or a fixture exists. New system prose goes through English catalogs; user-authored names remain database content.

For invitation work, start with recipient proof tied to the accepting session. The cached verified-email account column from #69 alone must never authorize joining. Requesting an email scope or hardcoding a verification claim is not verification. Then add participant invitations and capacity reservations in the Instance transaction, strict private command purposes, explicit preview/accept/decline/revoke, and durable central hint recovery. No GET/login autoacceptance, hidden Instance URL, inherited relationship consent or implicit technical ownership. Invite delivery must use configured transactional infrastructure, not a developer's personal email connection.

For ownership, use an explicit recipient offer/acceptance rather than silently assigning another member the owner role. The last owner can still leave; ownerless groups pause and final departure closes the dynamic. Removal and departure must fence pending invitations, jobs, grants and future notifications.

The connected membership/ownership slice is documented in [MEMBER_ADMINISTRATION.md](MEMBER_ADMINISTRATION.md). The private relationship slice is documented in [RELATIONSHIPS.md](RELATIONSHIPS.md). The consent/safety slice is documented in [CONSENT_SAFETY.md](CONSENT_SAFETY.md). The next functional block is #6/#7/#24 provider account/recovery/MFA and transactional delivery acceptance. Remaining #25/#26 privacy/export/deletion/restore work remains required before broader alpha onboarding; the member ending-marker schema is not a substitute for those release gates.

For relationships and consent, exercise a pair, a four-person Dom/Dom/sub/sub group and someone who is Dom to one member and sub/bottom to another. Consent is individual and version-bound. Neither payment, technical administration nor a role label supplies consent.

The account block retains the maintained IdP as credential/MFA/recovery handler. Changes must preserve the current issuer, client, flows, Brand/web certificate and accounts. Actual Google/Apple developer registrations, mail delivery and real-device MFA/recovery need configured provider access and live acceptance; signed fixtures are not that evidence.

## Release gates and scope limits

Across all blocks: #5/#12/#13/#31/#62 authorization/isolation/concurrency and outage tests; #44 translations; #28/#29/#30/#56 preserving deployment, encrypted off-host backups, isolated restore and alerts; #32/#33/#50 minimum privacy/incident/rights review. The complete minimal-input installer and remote fleet enrollment remain independent tracked work, not silently claimed by a passing update.

Invite-only pilot acceptance is #34. Real operator/mobile/provider evidence must be distinguished from repository CI. A source update does not deploy the server, send mail, enroll a remote host or accept consent.
