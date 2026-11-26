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
