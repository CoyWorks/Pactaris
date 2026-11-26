# Abuse reports and limited operator actions (#33)

Platform operators run the hosted service without routine access to household content. Operator authority is separate from household owner/admin roles and contextual Dom/sub roles, and requires the existing operator allowlist plus a fresh MFA sign-in (see [OPERATOR_ACCESS.md](OPERATOR_ACCESS.md)).

## Reporting

Every signed-in person can open **Report a problem or idea** on the Profile page, choose a category and describe what happened (at most 1000 characters). Owner decision, 21 November 2026: reports are mostly about the app itself, and Pactaris does not police what people agree to inside their dynamic. Categories: bug or error, sign-in or account problem, idea or suggestion, more members needed (with the dynamic; see [HOUSEHOLD_PLANS.md](HOUSEHOLD_PLANS.md)), possible minor (the one safety category, which the platform must act on), other. Reports filed earlier keep their old abuse categories (harassment, unwanted invitation, non-consensual, impersonation, spam); operators still see and close them. The request needs the session, exact Origin and CSRF token and is throttled per account. The operation ID is the report ID, so an uncertain retry cannot file a duplicate.

A report may name a household only if the reporter can currently access it; the API refuses any other household ID. Operators see the category, the reporter's account ID, the optional household ID, the text and the time. They see no household names, members, tasks, agreements or other content.

## Operator console

Reports arrive only in the operator console at `/operator` (operator allowlist plus a fresh MFA sign-in); nothing is e-mailed. The page lists open reports with their category. An operator can add internal notes (never shown to the reporter), close a report as actioned, no action or duplicate, and reopen it. See [OPERATOR_ACCESS.md](OPERATOR_ACCESS.md#operator-console) for the full console. Operators can suspend or restore an account by its account ID:

- **Suspend** sets the account to `suspended`, ends every Pactaris session and blocks new sign-ins. An operator cannot suspend their own account.
- **Restore** reverses a suspension only; it cannot reactivate a deleting or deleted account.

Every close, reopen, note, suspension, restoration and settings change is recorded in `pactaris.operator_events` with the operator account, action, target ID and time. The runtime can insert but not change or delete these records.

## Policy notes and limits

- There is no impersonation, content browser or exceptional-access tool. Any future exceptional access needs a separate scoped, time-limited and audited design.
- A suspended person cannot sign in, so they cannot use self-service export or deletion during the suspension. Handle such requests through the support route in [the incident and request procedure](PRIVACY_OPERATIONS.md) and restore access or act on their behalf where appropriate.
- Recipients can already decline invitations and owners/admins can revoke them. Blocking a specific person across dynamics is not implemented.
- Operators record who reviewed a report and how evidence is shared in their support process; the application does not send report content anywhere.

A report can name one of the reporter's dynamics; the form offers them. Operators see that ID, and from **Households** open the dynamic's plan to add extra member places.
