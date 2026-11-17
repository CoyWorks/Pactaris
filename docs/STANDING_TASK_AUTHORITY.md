# Standing task assignment — current source checkpoint

This implements the next #17 priority from [TASK_PLANNING.md](TASK_PLANNING.md). It adds one-off direct assignment and optional per-task acceptance to the existing participant lifecycle. Scheduling, series, rewards and broader #17 criteria remain open.

## Explicit scoped authority

A current participant selects an accepted task agreement, one recipient and either direct assignment or explicit per-task acceptance. Proposing a policy records the creator's exact directional grant request; it grants no authority until the recipient explicitly adopts that same policy version. The agreement must currently pass the activity guard at both proposal and adoption. Authority is an explicit technical resource grant separate from contextual role labels, household administration, billing and agreement participation. A contextual Dom/sub pair can use it without making labels into permissions; a switch can grant/receive different directions in separate relationships.

Policy terms (creator, recipient, agreement/version and mode) are immutable. Proposal is version 1, adoption advances to version 2, and either party can revoke or decline with an optimistic version. Changing terms requires a new proposal and adoption. Revoked policies cannot be restored. Append-only policy events retain actor/version/action/time. Only the two named parties can list policies, including inside a group agreement; unrelated administrators have no access. The bounded alpha allows 25 nonrevoked proposals/grants per household to keep the private response within its existing transport budget; this is a technical bound, not a commercial plan decision.

## Task behavior

The participant task editor offers individual offers plus active policies matching the exact creator, recipient and agreement version. Under a direct policy, assignment immediately creates an `assigned` task in both parties' active task lists. The recipient can start without accepting. History records `partnerAssign`, never a fabricated `partnerAccept`; detail shows the original mode and policy version. Under an explicit policy, a new task starts as `offered` and retains accept/decline behavior. Existing offers and private tasks are never converted.

Start, submit, creator review/changes and reopening retain their existing role/state rules. Reopening direct work returns to `assigned` under the same still-current grant; explicit/individual offers return to `offered`. Submission text and creator review remain required. No reward, consequence or points effect is executed. Titles, descriptions, priority and optional due instants retain existing validation/formatting.

Every protected transition rechecks the exact active grant and pinned agreement, current membership/consent, limits, expiry and pauses under the household lifecycle lock. Revocation blocks protected progress on existing tasks as well as new assignments. Pause/resume cannot bypass agreement renewal or stale decision fingerprints. Cancellation, declining offers and policy revocation require no fresh consent proof and remain available while paused, after agreement withdrawal or over quota. Departure revokes policies against the exact ended membership and cancels nonterminal work atomically; rejoining inherits no authority or content.

## API and persistence

All commands use the existing origin/CSRF/session-protected `/api/households/:id/participant-tasks/:action` surface and private signed, replay-protected delegation. The gateway resolves current membership and placement, validates bounded responses and stores no task/policy content. Policy revocation is exempt from the edit throttle, like cancellation.

- `partnerPolicyList`: operationId; returns at most 25 own proposed/active policies, exact versions, direction, local aliases and current safety fingerprint. Revoked policies stay in storage/history but are omitted from the live selector.
- `partnerPolicyPropose`: operationId, assigneeId, agreementId, agreementVersion, mode (`direct`/`explicit`), epoch, safetyVersion.
- `partnerPolicyAccept`: operationId, policyId, version, epoch, safetyVersion.
- `partnerPolicyRevoke`: operationId, policyId, version.
- `partnerAssign`: the existing offer fields plus policyId and policyVersion; the server derives the initial state from the adopted policy.

Policy/task mutation, event, minimal audit, receipt, durable outbox and delegation replay consumption commit or roll back together. Exact retries acknowledge historical operations; they do not restore revoked authority or recreate cancelled work. Direct tasks use the existing combined private/shared active-task quota trigger for creation/reopen, including concurrent reservations and safe downgrade behavior. Policy adoption consumes no task capacity.

Migration `instance/0014_standing_assignment` is additive and preserves prior checksums/data/config/secrets and separate runtime/migration/backup roles. New policy tables have FORCE RLS and no direct runtime grants; the existing narrow participant command remains the entry point. Activate Instance before gateway through the preserving updater. No new operator inputs or Identity/TLS/domain/proxy changes are needed. Falling back application code does not undo schema/state or make old clients capable of displaying newly assigned states; retain a compatible runtime once direct assignments exist.

## Verification and limits

Regression tests cover strict inputs, recipient-only adoption, explicit direction/mode presentation, pending-grant denial, direct list/start/review/reopen, immutable old offers, explicit mode, wrong direction/admin/group privacy, revoke/adopt races, pause/revocation, quotas/downgrade, transactional final-outbox failure, runtime table/helper denial and departure/rejoin. The native two-Instance HTTPS fixture remains the authoritative integration gate; source tests are separate from live operator/mobile acceptance.

In this development sandbox, targeted input/render tests and real PostgreSQL single-user migration/command checks can run; TCP and Unix socket creation is prohibited, preventing the complete PostgreSQL/HTTPS integration fixture. Do not describe that fixture as passed or deploy from this evidence alone.

Planners/upcoming series, recurrence/worker generation (#18), reward/points (#20/#64), notifications (#22), protocol/session links, configurable proof/file requirements (#21), third-party reviewers/disputes, complete export/deletion/retention and trusted restore replay remain open. Participant tasks currently have their own active list; the overview's existing private-task counts are not a cross-module aggregate. No browser visit generates scheduled work.

Documentation consulted: AGENTS.md, README.md, DEVELOPMENT.md, ARCHITECTURE.md, DOMAIN_MODEL.md, PLANS.md, INFRASTRUCTURE.md, EXISTING_SITE.md, EARLY_VERSION_BASICS.md, OBEDIENCE_BASELINE.md, INTERNATIONALIZATION.md, RELATIONSHIPS.md, CONSENT_SAFETY.md, WORKSPACE_TASKS.md, PARTICIPANT_TASKS.md, TASK_PLANNING.md, PRIVATE_COMMANDS.md, LOGIN_GATEWAY.md, LOGIN_ROLLOUT.md, FIRST_INSTALL_NOTES.md and CONTRIBUTING.md.
