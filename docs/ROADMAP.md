# Build order and release gates

Use the linked issues as scoped work items. Phase tags describe roadmap groups; this repository does not yet have GitHub milestone objects. Dependencies in issue bodies establish the starting order, not a promise that every step must be developed serially.

## M0 — Hosted foundation

1. Decide runtime/hosting boundary ([#1](https://github.com/CoyWorks/Pactaris/issues/1)), map the source ([#2](https://github.com/CoyWorks/Pactaris/issues/2)) and settle source licensing ([#50](https://github.com/CoyWorks/Pactaris/issues/50)).
2. Create the scaffold ([#3](https://github.com/CoyWorks/Pactaris/issues/3)), PostgreSQL model ([#4](https://github.com/CoyWorks/Pactaris/issues/4)), isolation ([#5](https://github.com/CoyWorks/Pactaris/issues/5)) and accounts ([#6](https://github.com/CoyWorks/Pactaris/issues/6)).
3. Add explicit household invitations ([#8](https://github.com/CoyWorks/Pactaris/issues/8)), authorization ([#9](https://github.com/CoyWorks/Pactaris/issues/9)), consent ([#10](https://github.com/CoyWorks/Pactaris/issues/10)) and safety ([#11](https://github.com/CoyWorks/Pactaris/issues/11)).
4. Make audit/side effects transactional ([#12](https://github.com/CoyWorks/Pactaris/issues/12)) and prove core behavior in CI ([#13](https://github.com/CoyWorks/Pactaris/issues/13)).

Exit check: two unrelated households cannot access each other; a user can have different permissions in both; withdrawal blocks protected work; one member cannot resume another's paused participation. No real user data is needed for this check.

## M1 — First usable product

1. Port the safe PWA shell ([#14](https://github.com/CoyWorks/Pactaris/issues/14)) and daily view ([#15](https://github.com/CoyWorks/Pactaris/issues/15)).
2. Complete protocols ([#16](https://github.com/CoyWorks/Pactaris/issues/16)), one task lifecycle ([#17](https://github.com/CoyWorks/Pactaris/issues/17)) and recurrence/jobs ([#18](https://github.com/CoyWorks/Pactaris/issues/18)).
3. Add check-ins ([#19](https://github.com/CoyWorks/Pactaris/issues/19)), optional ledger ([#20](https://github.com/CoyWorks/Pactaris/issues/20)) and private attachments ([#21](https://github.com/CoyWorks/Pactaris/issues/21)).
4. Add inbox ([#22](https://github.com/CoyWorks/Pactaris/issues/22)), Web Push ([#23](https://github.com/CoyWorks/Pactaris/issues/23)) and transactional email ([#24](https://github.com/CoyWorks/Pactaris/issues/24)). Email setup may need to begin earlier to exercise account verification/invitations.
5. Finish personal/household export ([#25](https://github.com/CoyWorks/Pactaris/issues/25)), leave/deletion ([#26](https://github.com/CoyWorks/Pactaris/issues/26)) and settings ([#27](https://github.com/CoyWorks/Pactaris/issues/27)).

First vertical slice: sign in, create/join, explicitly accept, create/complete a task, pause, export and leave. Demonstrate this in staging before expanding all modules. Recurring jobs and notification delivery must work with the browser closed.

## Launch — Public-service readiness

Complete MFA/session controls ([#7](https://github.com/CoyWorks/Pactaris/issues/7)), OCI deployment ([#28](https://github.com/CoyWorks/Pactaris/issues/28)), backups/restore ([#29](https://github.com/CoyWorks/Pactaris/issues/29)), monitoring/capacity ([#30](https://github.com/CoyWorks/Pactaris/issues/30)), security/concurrency checks ([#31](https://github.com/CoyWorks/Pactaris/issues/31)), policy review ([#32](https://github.com/CoyWorks/Pactaris/issues/32)) and limited platform administration ([#33](https://github.com/CoyWorks/Pactaris/issues/33)).

Run the invite-only pilot ([#34](https://github.com/CoyWorks/Pactaris/issues/34)) with at least two unrelated households, a multi-household user and target mobile devices. Public onboarding remains gated until findings and operational ownership are resolved.

A successful demo is not a production acceptance test. Verify database isolation, private-content visibility, real worker safety checks, restore/deletion reconciliation and proxy/session behavior on representative infrastructure.

## Later — Product expansion

Relationships/standing, bounded delegation, templates, planner/ICS, constrained Automation Studio, search, opt-in insights, hosted subscriptions, scoped APIs/webhooks and Dutch/English localization. Each has a separate issue in the [inventory](FEATURE_INVENTORY.md).

## Good-to-have and wishes

Safe themes/layouts/custom fields; private journaling; mobile wrapper; narrow E2EE research; opt-in external integrations. Research and user evidence come before implementation commitments.

## Existing Site and versions

Leave the existing Site at version 4 during planning. Do not reset history, deploy this documentation as a new version or imply application functionality exists in this repository. The first implementation will be a new development build after source/stack review; choose its release number when its scope is real.
