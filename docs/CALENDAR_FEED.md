# Calendar subscription (ICS) and hidden titles (#38)

Owner decisions, 26 November 2026:
- People can subscribe to their Pactaris calendar in Google, Apple and Outlook, so a change in Pactaris shows up there.
- Titles are included, because they are often ordinary ("Drink water").
- When creating a task, series, habit or routine, the creator can choose to hide its title in subscriptions.

## The link

- **Tasks → Calendar → Add to your calendar** creates a private link for this account and this dynamic: `https://<app>/calendar/<secret>.ics`. A `webcal://` form is offered for Apple Calendar.
- There are buttons for Google ("From URL"), Apple (webcal) and Outlook.
- The secret is 32 random bytes (43 characters). Gateway migration `0029_calendar_feeds` stores only its SHA-256, with at most one link per account and dynamic. The link is shown once.
- **Get a new link** replaces the secret, so the old link stops at once. **Stop the subscription** deletes it.
- A link also stops working when the account is no longer active, or when the account is no longer a member of the dynamic: the Instance refuses the planner read, and the feed returns 404.
- Requests are rate-limited per link (60 per window) and answered with `Cache-Control: private, max-age=300`.

## What the calendar contains

The feed is the account's own planner ([PLANNER.md](PLANNER.md)) from 7 days ago to about 11 weeks ahead, in the account's presentation time zone (UTC if none is set). It never contains other people's calendars.

- An item with a time becomes a 30-minute event at that time. Other items become all-day events.
- `SUMMARY` is the title, or "Pactaris" when the title is hidden. There is no description.
- Each event has a `URL` back to the app's calendar. It contains the dynamic's ID, no content.
- Planned breaks are left out.
- Each occurrence keeps a stable `UID`, so calendar apps update events in place.
- The calendar asks for hourly refreshes (`REFRESH-INTERVAL`, `X-PUBLISHED-TTL`). Apple and Outlook honour this roughly. Google refreshes on its own schedule, often every several hours, and Pactaris cannot speed that up.
- What a calendar app has already fetched stays there until the app refreshes, or until the person removes the subscription. Revoking a link cannot recall copies.

## Hidden titles

- Instance migration `0069_calendar_privacy` adds `calendar_hidden(household_id, resource_id)`.
- `calendar_mark` sets or clears the choice. It is allowed for:
  - the creator of a private task, series or routine;
  - the creator or assignee of a shared task or task series;
  - the Dom or sub of a Dom-set habit.
- A series' choice also covers the occurrences it creates.
- Create forms have the checkbox "Hide the title in calendar subscriptions" for:
  - quick add;
  - private tasks and repeating private tasks;
  - giving a shared task or series;
  - Dom-set habits;
  - routines.

  After the item is created, the form stores the choice. If that second step fails, the item exists with a visible title, and the person is told to change it from Calendar.
- In **Calendar**, each of your own items has an eye button to change it later.
- The app itself always shows titles.

## Interfaces

- Gateway:
  - `GET /calendar/:secret.ics`
  - `GET|POST|DELETE /api/households/:id/calendar-feed`
  - `POST /api/households/:id/calendar-mark {kind,resourceId,hidden}`
- Workspace actions: `plannerRead` now returns `hidden` per item, and the new action `calendarMark`.
- Code: `apps/gateway/calendar-feed.ts` (`CalendarFeeds`, `icsCalendar`).
