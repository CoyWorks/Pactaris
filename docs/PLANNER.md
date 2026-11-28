# Planner (#38)

Owner decisions, 26 November 2026:
- The planner lives in **Tasks → Calendar**, next to Mine and Shared.
- **Today** shows a short overview of the coming week.
- An ICS subscription for external calendars shows titles, and each item can be set to hide its title there; see [CALENDAR_FEED.md](CALENDAR_FEED.md).

## What it shows

One read-only list of everything with a date, for one person and a range of local days in the dynamic's time zone (at most 42 days per request):

| Kind | Source | Visible to |
|---|---|---|
| Private task | `tasks` with a due time | its creator only |
| Private task, repeating | future occurrences of `personal_task_series` not created yet | its creator only |
| Shared task | `partner_tasks` assigned to the person: due time, else the time it becomes available; declined and cancelled tasks left out | the person, and whoever holds task authority over them |
| Shared task, repeating | future occurrences of `task_series` not created yet (`task_occurrence_at`) | same |
| Habit set by a Dom | `authority_habits`: daily habits on their weekdays, weekly habits once per week. Past days carry their result (reached, missed, skipped); planned breaks are marked | same |
| Own habit, ritual or check-in | `routines` at their current revision: daily (weekdays), weekly, once | its creator only |

The person filter offers yourself plus everyone you hold task authority over (`authority_area(…,'tasks')`). Asking for anyone else is refused. Projected occurrences are marked as such and never written; the worker still creates real occurrences as before.

## Views

- **Next 7 days** (default): a list per day. Shared and private tasks that are still overdue from the previous 14 days appear first, under "Still open from earlier".
- **Week**: Monday to Sunday. Days without items say so.
- **Month**: a grid with up to three dots per day (red for overdue). Tapping a day lists it below.
- Tapping an item opens the place where it is managed: Mine, Shared, Today (own Dom-set habits), People (someone else's habit), Habits, or Check-ins.

## Interface

- Instance: `pactaris.planner_read(target, instance, actor, body)` (migration `0068_planner`), workspace action `plannerRead`. The gateway validates the response shape.
- Gateway: `GET /api/households/:id/planner?from=YYYY-MM-DD&days=1..42&timeZone=IANA[&person=membershipId]`.
- Web: `apps/instance/web/planner.tsx` (`PlannerView`, `WeekGlance`).

## Limits

- At most 600 items per request.
- Weekly routines and habits show once per week, on the first day of that week in the range.
- The planner does not move or edit anything, except whether an item's title is hidden in calendar subscriptions ([CALENDAR_FEED.md](CALENDAR_FEED.md)). Dragging items to another day is not part of this version.

## Moving items to another day

Owner request, 28 November 2026. Instance migration `0074_planner_move`, workspace action `plannerMove`, `POST /api/households/:id/planner/move {kind,itemId,day,timeZone}`.

- **What moves:** one-off items with a due date.
  - In your own calendar: your own open tasks.
  - In the calendar of someone you hold task authority over: the Dom/sub tasks you created that are not finished.
  - Repeating items, habits and routines do not move.
- **How:**
  - Drag an item to another day: an agenda or week day, or a month cell.
  - On phones, use the item's calendar button and pick a date.
- **Rules:**
  - The time of day stays in the viewer's time zone; only the date changes.
  - Moving to a day in the past is refused.
  - The plan horizon applies (`workspace_horizon`).
  - A paused dynamic or a personal pause stops moving, as for any edit.
- **For a Dom/sub task:** a `partnerMove` event is recorded, shown in the task history as "Moved to another day". A reminder that was already sent becomes due again for the new date.
- Every move is audited (`workspace.plannerMove`).
