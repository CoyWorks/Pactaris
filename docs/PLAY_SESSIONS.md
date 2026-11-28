# Play sessions

Owner decisions, 28 November 2026. Instance migration `0075_play_sessions`.

A play session is a note-style entry in a person's **own calendar** (Tasks → Calendar → *Play session*). It can be about a session with anyone, including people outside the app or outside the dynamic.

## What a session holds

- **Basics:** title, start, duration (5 minutes to 24 hours), location, and *with whom*. *With whom* is free names, linked to nobody.
- **The writer's notes:**
  - preparation and agreements (the plan, wishes, limits, safeword);
  - aftercare and looking back.
  
  Each note is up to 2,000 characters and is saved on its own (`sessionNote`), so every request stays within the 4 KB command limit.

## Who sees it

- **Private by default.** Only the person who writes it sees it. Administrators and the household owner do not see it.
- **Linking a member is optional, per person:**
  - *may view*: the session appears in their own calendar, and they see the whole session including the writer's notes.
  - *may view and write their own part*: they also keep their own preparation and looking back.
  - Removing a link removes that person's part.
- A linked member whose writer left the dynamic no longer sees the session.
- Only the writer edits the basics, changes links, moves or deletes the session. Deleting removes every linked part (`sessionDelete`). A session is a personal note, not a record.

## Calendar

- Sessions appear in the planner as *Play session*. Linked sessions show with state `shared`.
- They also appear in the ICS subscription with their real duration.
- The usual "hide the title in calendar subscriptions" option applies.
- The writer can move a session to another day, keeping the time of day (`plannerMove` with `kind:'session'`).

## Plans

Sessions count towards no plan limit, and the plan horizon does not apply.

## Interfaces

- Workspace actions: `sessionRead`, `sessionSave` (`sessionId:null` creates; the operation ID becomes the session ID, so a retry is harmless), `sessionNote`, `sessionDelete`.
- These go through `POST /api/households/:id/workspace/:action`.
- Instance functions: `play_session_read`, `play_session_save`, `play_session_note`, `play_session_delete` and `play_session_access`.
- Code: `apps/instance/web/play-sessions.tsx`.

## Export and deletion

- **Personal export,** section `playSessions`: each session the person wrote (with the IDs of who they linked, never other people's parts), and their own part in each session they are linked to.
- **Account deletion:** removes the person's sessions and their own parts before the existing erasure runs.
