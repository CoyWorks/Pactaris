# Personal export

From the household selector, request the JSON download as the account holder. The gateway checks the browser session, origin, CSRF token and signed provider authentication time before issuing the download. Authentik can reauthenticate through `/auth/reauth`. The download is streamed in the browser response and is never retained in a gateway export directory.

Version 1 is a bounded preview of personal portability. It includes basic account and presentation data plus up to five private workspace tasks and two currently retained documents authored by the exact active membership on each of up to four registered households. An Instance authorizes the command using its signed delegation and its current local membership. Lost membership or an unreachable Instance is reported as unavailable. Truncated scope is explicit, and the export declares itself incomplete. Other members' private records and deleted documents are excluded.

Complete exports, old memberships, attachments, user-visible export audit and queued downloads with expiry remain follow-up. Live tests should confirm that the configured provider emits a signed `auth_time` when reauthenticating.
