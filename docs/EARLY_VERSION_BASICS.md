# Early version: usable owner-only household

Owner direction, 17 November 2026: prioritize the usable everyday product from the existing ChatGPT Site before further relationship, emergency-procedure, fleet or account-provider depth. This supersedes the remaining feature execution order in ALPHA_P0.md; delivered foundations remain in place.

## Reference and present gap

The Sites service still reports reference version 4 at https://consent-households.coyseinri.chatgpt.site. The locally inspected reference source provides Home, Planner, Members, Household and More views, task creation with an optional assignee, rules/protocols, check-ins, rewards/ledger and household settings. See EXISTING_SITE.md for source provenance and limitations. This review is source/metadata inspection, not a new live interaction or security test; do not change or deploy the reference Site.

The hosted app already supports explicitly creating a household with exactly its creator as technical owner, without a partner, invitation or relationship. The missing product is a useful workspace after creation: the current page predominantly exposes membership/relationship/consent forms instead of daily household content.

## Required owner-only experience

A signed-in person creates a household, chooses its name and basic settings, and immediately reaches an empty, usable dashboard. They can prepare its content before inviting anybody. Do not require a second member, a relationship, a two-person agreement or invented placeholder users for setup.

- Household name and timezone/settings are editable by the authorized owner. Personal display identity stays separate.
- Tasks can be created with title, description, priority and optional due date, saved without an assignee, edited and archived. A person can explicitly assign a task to themselves and complete their own work without inventing a second relationship participant.
- Rules/protocols can be drafted, edited, ordered/published and archived as a household library before anyone joins. Drafting or reading is not another person's acknowledgement or consent.
- The dashboard shows real permitted content and useful empty/loading/error states, with clear routes for tasks, rules/protocols, members and settings. Hide complexity behind relevant sections rather than presenting every advanced form on entry.
- Notes/ideas provide a small personal-private planning area; sharing is explicit and optional. Member invitations remain available when the owner chooses to use them.
- Prepare habit/check-in definitions and reward catalogs in subsequent small releases. Do not confuse configuring a catalog/template with granting a reward, imposing a consequence or executing an automation against somebody.

## Delivery order

| Order | Existing issues | First deliverable |
| --- | --- | --- |
| 1 | #15, #27, #8 | Owner-only setup/settings, mobile workspace/navigation and useful dashboard/empty states |
| 2 | #17, #53 | Basic unassigned/self-assigned task CRUD and own completion; bounded lists, due dates and priority |
| 3 | #16 | Rules/protocol library and drafts; explicit versions/acknowledgement when another participant is involved |
| 4 | #66 | Private notes/ideas; explicit sharing and basic edit/archive behavior |
| 5 | #63, #19 | Basic habits and ritual/check-in definitions, then daily use |
| 6 | #64, #20 | Reward catalog preparation, then consent-aware redemption/ledger |

Start with #15/#27 and the minimal task slice of #17 as the next buildable release. Full PWA installation/caching, a rule library, social login and advanced privacy workflows are not dependencies for rendering the basic dashboard or saving an unassigned task draft. Reuse available foundations and split wider issue criteria into later checkpoints instead of building the entire dependency graph first.

## Boundaries retained

Keep tenant/resource authorization, private data, transactions, translation files and existing consent/pause checks. Basic setup, drafts and self-directed work must have an appropriate policy instead of being forced through a partner-relationship guard. Assigning work to another person, partner review, consequences, automatic rewards or automation still requires the relevant authorization, explicit participation and current safety/consent checks. No automatic acceptance or coercive defaults. Do not disable the existing activity guard to make a draft editor work.

Keep advanced relationship/consent/emergency screens accessible in suitable sections, but defer expansion and stop making them the first-use product. Do not remove implemented safeguards or migrate existing data away as an incidental UI simplification. Mandatory security/privacy/operational release gates still apply before wider public onboarding; changing feature order does not mark those gates complete.

## End-to-end acceptance for the next release

With one fresh account and no invitations: create household; edit its name/timezone; open its dashboard; save an unassigned task; edit it; assign a separate task to oneself and complete it; reload and verify persistence. No relationship/agreement creation is requested for these owner-only actions. Another household cannot list/read/edit this content. Existing safety controls remain available, and partner-directed execution is not silently enabled. Only appropriate meaningful tests run, with compact output per DEVELOPMENT.md.

## First everyday checkpoint — 0.8.0-alpha.1

The owner-only dashboard/navigation, name/timezone settings and private unassigned/self-directed task workflow are implemented in this checkpoint. Contract, safety/quotas, tests and explicit limits: [WORKSPACE_TASKS.md](WORKSPACE_TASKS.md). Partner assignment/review, shared boards, recurrence, uploads and rewards remain open. Next everyday modules are the rules/protocol library (#16), then private notes (#66). Source/CI completion is not live operator/mobile acceptance.
