# Exchanges, agreement reviews and household words

Pactaris supports long-term dynamics in which the people involved agree on things together and then record them. Within what they agreed, the person holding task authority leads. This module adds the day-to-day exchanges that go with that, without replacing the conversation: nothing here assigns work, moves points, changes an agreement or runs a consequence.

## Who can exchange with whom

Only an **active standing task authority** connects two people: a Dom link, a delegation or a sub rank (see [HOUSEHOLD_AUTHORITY.md](HOUSEHOLD_AUTHORITY.md)), or an adopted assignment policy (see [STANDING_TASK_AUTHORITY.md](STANDING_TASK_AUTHORITY.md)): an assignment policy that the person under authority adopted, in an active relationship that neither participant has paused. Household roles, dynamic role labels and relationship labels grant nothing.

| Kind | From | To | Answer |
| --- | --- | --- | --- |
| Permission request | person under authority | holder | approve or decline, optional reply; optional "answer needed by" time after which it shows as *no answer in time* and can no longer be answered |
| Proposal | either | the other | accept or decline, optional reply |
| Journal entry | person under authority | holder | acknowledge, optional comment |
| Rule breach | holder | person under authority | none: recorded at once and shown to them for 7 days on Today; can come with a punishment task |

An approved request or accepted proposal records the answer only. Acting on it (a new rule, task or change) stays a separate, explicit step in the relevant module. A breach record never runs a consequence by itself; the Dom can give a punishment with it.

Creating or answering is refused while the household is paused or stopped, or either person or their relationship is paused. Withdrawing always works: requests and proposals while still open, journal entries and breach records by their author at any time. Withdrawing blanks the text for both people and is recorded in the revocation journal as `exchange.withdrawn`, so a restored backup cannot bring the text back. If the authority ends later, existing records stay readable to both people but open items can no longer be answered.

Each person can have at most 50 open items. Text is limited to a 120-character title, 600 characters of text and a 500-character reply. Lists page by 8 items, newest first.

## Agreement reviews

Each accepted participant of an active relationship can give an agreement a review rhythm (1, 3, 6 or 12 months) and mark it as reviewed. The next review date is shown to both people and appears on Today from a week before it is due. A review rhythm is a reminder only: it does not change, renew or expire the agreement.

## Household words

Owners and admins can rename the Tasks, Routines, Library and Dynamic sections for everyone in the dynamic (up to 24 characters each). The words are user content and are shown as typed; empty fields fall back to the English catalog.

## In the app

- **Today → Needs your attention:** open items addressed to you and agreement reviews that are due.
- **Dynamic → Requests and journal:** waiting and all items, a page per item, and a page to create one. The recipient list follows the kind.
- **Dynamic → People** (only when you hold task authority over someone): per person, what is waiting for you, shared tasks submitted for your review and overdue shared tasks you assigned, with shortcuts to assign a task or record a breach. It only shows what the person already shares with you; their private habits and notes stay private.
- **Dynamic → Agreement reviews** and **Dynamic → Settings → Your own words**.

## Security and privacy

- Instance tables `exchanges`, `exchange_receipts`, `agreement_reviews` and `household_terms` use FORCE RLS; the runtime role reaches them only through `exchange_command` and `exchange_export_page`.
- Commands use signed per-request delegation, operation IDs with request fingerprints and receipts, an audit event per change, and the restore fence.
- The gateway stores no exchange text. Responses are validated field by field before they reach the browser.
- Personal export section `exchanges` contains items the person wrote or received (not withdrawn ones).
- Account erasure withdraws the person's own items and blanks their replies on items they received.
