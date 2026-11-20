# Mobile layout

The browser app is designed for a phone first and scales up to a centred column on larger screens. This document describes navigation and layout only. Consent, safety, privacy and authorization behaviour is unchanged and described in the module documents.

## Start page and routes

| Route | Content |
| --- | --- |
| `/` | Your dynamics. With exactly one dynamic, and no partial list, further page or pending creation, the app replaces this route with that dynamic. With several, it opens the dynamic this account last opened in this browser, if it is still in the list. |
| `/?all` | The list without the automatic opening, used by the dynamic switcher in the top bar and to create another dynamic. |
| `/households/:id?view=…` | The workspace. `view` selects a section; Today has no parameter. |
| `/profile` | All account settings. |
| `/join` | Invitation acceptance (unchanged). |

The gateway serves the same HTML for these paths. Moving between them uses the History API, so switching tabs or sections does not reload the page. Browser Back follows the sections the person opened. Signing out, leaving a dynamic and account switches still reload the page.

## Workspace

- **Top bar:** the dynamic's name (opens the switcher list), the notifications bell (dot when something is unread), the safety shield and the avatar (Profile). The shield is on every workspace screen and turns red while the dynamic is paused.
- **Bottom tabs:** Today, Tasks (My tasks / Shared tasks), Routines (Habits / Rituals and check-ins), Library (Rules and protocols / Notes and ideas) and Dynamic.
- **Dynamic tab:** Doms and subs, people (only when you hold authority over someone), household board (when you are part of an active Dom link), requests and journal, members and invitations, relationships and agreements, reward catalog, agreement reviews, safety and my limits, and settings (including your own words for sections, and leave). See [DYNAMIC_EXCHANGES.md](DYNAMIC_EXCHANGES.md).
- **Household words:** when owners set their own words for Tasks, Routines, Library or Dynamic, the tabs show those.
- **Today:** open tasks with a complete action, unread shared work (opens Notifications, where the task inbox now lives; Shared tasks no longer repeats it), up to four active habits with their current period total and a **+1** button, counts and shortcuts. Habits are read when Today opens and after a change, not polled. Below them, check-ins and rituals that are active, open in their current period and not yet answered appear with **Answer**; the section is hidden when nothing is due. Answering opens a page with the prompt, the response type's input (text, a 1–5 rating, or yes/no; rituals only confirm) and an optional note, and records one `progressRecord` at server time. The reflection notice stays visible on that page. At most four check-ins and rituals are read. Empty sections show one line and one action instead of an explanation.
- **Add button:** a bottom sheet. Private task, habit and note open a short form inside the sheet; **More options** opens the full form. A task for someone opens the **Give a task** page; check-ins, rules and rewards open their section, because their consent, audience and scope choices need the full form.

### Quick add

| Item | Fields | Result |
| --- | --- | --- |
| Private task | Title, optional due time, "I'll do this myself" (on by default) | `taskCreate`, unassigned when unticked |
| Habit | Name, times per day, "Start tracking now" (on by default) | `routineCreate` as a daily minimum habit; when ticked, a separate `routineRead` and `routineActivate`. If starting fails (for example during a pause) the draft remains and the sheet says so |
| Note | Title, optional text | `documentCreate` as a private note with no recipients |

Each form keeps its operation ID until the input changes, so retrying after an unconfirmed outcome repeats the same request. **+1** on Today records one `progressRecord` entry at server time with the habit's current version, revision and safety epochs; pause and limit checks apply exactly as in Routines.

## Detail pages

Opening a task, shared task, routine, library item or catalog item, and every create or edit form in those modules, shows a full-screen page with a Back button instead of expanding inside the list. Escape also closes it, and focus returns to where it was. Errors, notices and retry or confirmation prompts of the module are shown on that page while it is open.

Relationships, members and invitations use the same pattern: compact lists, with a page for a relationship (details, roles, agreements, accept/decline/withdraw and its confirmation), for proposing a relationship, for your name in the dynamic, for another member (role, remove, offer ownership) and for each member confirmation. Raw membership and invitation IDs are no longer shown in the lists. When pages are stacked, Escape closes only the top one.

## Swipe and undo

In Today and My tasks, swipe a task right to complete it (only self-assigned open tasks) or left to archive it. Each swipe has a visible alternative: the round complete button on the row, and Archive on the task page. Complete and archive wait five seconds before the command is sent, with an **Undo** toast; leaving or hiding the page sends a waiting command immediately. Undo cancels it before anything reaches the server, so there is no reopen or reassignment involved. Tapping an open task opens its edit page.

## Last used dynamic and theme

Two per-browser conveniences are kept in local storage, wrapped so that blocked storage simply disables them:

- `pactaris.lastDynamic`: the account ID and household ID last opened (no names). Ignored for another account and removed on sign-out.
- `pactaris.theme`: `light` or `dark` from **Appearance** in Profile. Without it the app follows the system colour scheme.

## Wider screens

From 900 CSS pixels the bottom tabs become a side navigation, the content keeps a readable width, sheets become centred dialogs and tile grids use four columns.

## Profile

The avatar opens Profile: display name, date and time, notifications, appearance, signed-in sessions, personal export, report a problem, sign out and delete account. These panels used to sit on the household selector.

## Help text

Longer explanations of a section or form are collapsed behind **More info** (a native `details` element, readable by assistive technology). Confirmation notices, consent statements, errors and safety status shown at the moment of a decision stay visible.

## Loading

Loading shows placeholder rows instead of text. The rows are decorative; a visually hidden status text keeps the loading state available to screen readers, and the shimmer stops when the system asks for reduced motion.

## Accessibility

Interactive controls are at least 44 by 44 CSS pixels. Icons are decorative and every icon-only control has a translated accessible name. Segmented controls use `tablist`/`tab` roles; the bottom navigation marks the active tab with `aria-current`. Sheets are labelled dialogs that close with Escape or the backdrop.

## Manual check

On a phone-sized viewport: sign in with one dynamic and verify it opens directly; use Back and verify the app does not loop; open the switcher and create a second dynamic; check every tab, the shield, the add sheet and Profile; confirm pause/stop from the shield while on another tab.
