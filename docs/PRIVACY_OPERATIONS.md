# Privacy operations: data inventory and draft procedures (#32)

**Status: draft for owner and legal review.** This document records what the current code stores and proposes operating procedures. It is not a privacy notice, terms of service or a claim of GDPR or other legal compliance. Items marked *Decision* need an owner decision, and the privacy notice, terms, lawful basis and age policy need appropriate legal review before public onboarding.

## Data inventory

Pactaris processes data about sexual practices and intimate relationships. Treat everything inside an Instance as special-category, highly sensitive data.

| Category | Stored where | Contents | Purpose | Who can access through the application |
| --- | --- | --- | --- | --- |
| Account identity | Gateway DB | Issuer and subject, provider display name, optional preferred name, verified email and assertion time, formatting locale and time zone | Sign-in, invitations, presentation | The account holder; never other members |
| Sessions and devices | Gateway DB | Hashed session tokens, expiry, recent-authentication times, Web Push endpoints and keys (encrypted) | Sessions, MFA freshness, notifications | The account holder (session list) |
| Routing metadata | Gateway DB | Registered Instances, household placements, account-household visibility hints, operation records | Hidden routing, recovery | Operators (counts and IDs only) |
| Invitation mail queue | Gateway DB | Encrypted recipient address and token until delivery or expiry | Invitation delivery | Nobody; removed at terminal state |
| Revocation journal copy | Gateway DB | IDs, versions and status codes of revocations and deletions | Restore safety | Nobody through the UI |
| Abuse reports | Gateway DB | Category, reporter account ID, optional household ID, report text | Abuse handling | MFA-verified operators |
| Operator and export events | Gateway DB | Operator actions with target IDs; export time and completeness | Accountability | Operators via the database |
| Identity provider | Authentik DB | Credentials, MFA factors, email, recovery state | Authentication | Identity administrators |
| Household content | Instance DB | Household name, memberships and aliases, relationships, contextual roles, agreements, limits, consent decisions, safety state, tasks, schedules, documents, habits and check-ins, rewards and points, inbox, small draft attachments | The product | Per-resource participants only; household administrators get no extra access to private content |
| Audit, receipts, outbox | Instance DB | Operation and resource IDs, event keys, minimal results | Idempotency, accountability | Nobody through the UI |
| Backups | Host and off-host target | Database checkpoints of all components, age-encrypted off-host | Recovery | Operators holding the backup key |
| Logs | Host | Structured service codes; CloudPanel access logs in the [minimised format](CLOUDPANEL_ACCESS_LOGS.md) | Operations | Host administrators |

## Processors and transfers

| Processor | Role | Data | Decision |
| --- | --- | --- | --- |
| Hosting provider (OCI, current host `cw-web01`) | Infrastructure | Everything | Record the region and the contract terms |
| Off-host backup target | Storage | Encrypted checkpoints only | Choose the provider and region |
| SMTP relay | Email delivery | Recipient address, generic message | Choose a provider whose acceptable-use policy allows this service |
| Web Push services (browser vendors) | Notification delivery | Push endpoint, encrypted generic payload | Accept per browser; payloads carry no household data |
| Google and Apple sign-in, when enabled | Identity | Provider subject, name, email | Review provider terms |
| GitHub | Source hosting and CI | No user data | None |

*Decision:* confirm that every processor's acceptable-use policy permits adult BDSM/kink content before adopting it, and keep this table current.

## Retention (proposal)

| Data | Proposed retention |
| --- | --- |
| Active account and household content | While the account or membership exists |
| Ended memberships | Minimal history stays for the remaining participants; personal-private content is archived and removed on account deletion |
| Deleted account | Reduced immediately to an unlinkable marker after every Instance acknowledges erasure |
| Sessions | Up to the configured absolute lifetime |
| Abuse reports | Closed reports: proposed 12 months, then delete |
| Operator and export events | Proposed 24 months |
| Local checkpoints | Proposed 14 days; local pruning is not automated yet |
| Off-host backups | `keep` setting, proposed 14 daily copies; restored copies replay deletions through the revocation journal |
| Access logs | Proposed 30 days |

*Decision:* confirm or change these periods. Retention jobs for reports, events and local checkpoints are not implemented yet.

## Requests from people

| Request | Handling |
| --- | --- |
| Access / portability | Self-service personal export ([PERSONAL_EXPORT.md](PERSONAL_EXPORT.md)) |
| Erasure | Self-service account deletion ([ACCOUNT_DELETION.md](ACCOUNT_DELETION.md)); Identity accounts are removed separately in Authentik |
| Rectification | Self-service editing in the app |
| Request from a suspended person, or about data the person cannot reach | Through the support contact; verify the requester through their signed-in account or Identity, never by email alone; act within the legal deadline |
| Request about another person | Refuse; Pactaris never discloses one person's data to another outside the product's sharing rules |

*Decision:* publish one support contact and name who handles requests.

## Incidents and breach assessment (draft)

1. **Contain.** Pause live deployment (`systemctl stop pactaris-live-deploy.timer`), revoke exposed credentials, and suspend affected accounts if needed.
2. **Preserve evidence** without copying household content: service logs, operator events, revisions and timestamps.
3. **Assess** which categories, people and Instances are affected, using the inventory above. Assume Instance content is sensitive special-category data.
4. **Decide on notification** to the supervisory authority and affected people within the legal deadlines that apply. *Decision:* name the responsible person and get advice on the applicable deadlines.
5. **Recover** using [RECOVERY.md](RECOVERY.md); restored Instances replay revocations before serving.
6. **Record** the incident, decisions and follow-up in a private incident log, and add regression requirements to [FIRST_INSTALL_NOTES.md](FIRST_INSTALL_NOTES.md) where they concern operations.

## Content policy (draft outline)

- Pactaris is for consenting adults only. Accounts that appear to belong to minors are suspended pending review; reports in the "possible minor" category are handled first.
- Consent is explicit, individual and revocable. Content or behaviour that promotes non-consensual activity, coercion, blackmail or covert monitoring is not allowed.
- No content involving minors, no illegal content and no sharing of another person's private data without their consent.
- Harassment through invitations, reports or other features leads to suspension.
- Reports go through **Report a problem**; operators see only the report, never household content.

*Decision:* final wording, age policy and how age is asserted without collecting unnecessary identity evidence, with legal review.
