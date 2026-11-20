# Notifications

## In-app notices

Every member has a notice list per dynamic (bell in the top bar). Notices are created by database triggers in the same transaction as the change, so a notice exists exactly when the change committed. A notice holds only its kind, the resource ID, the acting member and a time: never titles or text.

| Kind | Recipient | When |
| --- | --- | --- |
| `permission`, `proposal`, `journal`, `breach` | recipient of the exchange | an exchange is created |
| `answered` | author | a request or proposal is approved or declined, or a journal entry is acknowledged |
| `invited` / `accepted` / `ended` | sub / Dom / the other party | a Dom link is offered, accepted or ended |
| `delegated` | delegate | authority over a sub is delegated |
| `points` | person whose points changed | a manual or automatic point change |
| `habit` | sub | a habit period was checked (not for skipped periods) |

Task notices (assigned, submitted, reviewed, reminders) stay in the existing task inbox and appear on the same page. A withdrawn exchange removes its notices; leaving a dynamic or erasing an account removes the person's notices. Opening the page marks notices read. Notices have no actor for automatic outcomes.

## Settings

**Profile → Notifications** (`/profile/notifications`) holds every notification setting in one place:

- **This device:** allow or stop notifications in this browser (Web Push enrolment).
- **Per dynamic:** whether the dynamic may notify you, which kinds you receive, and quiet hours in your time zone. Kinds are grouped as tasks (assigned, submitted for review, reviewed, reminders), requests/journal/breaches, Doms and subs, and points and habits.

A turned-off notice kind (`notice_preferences.muted`, migration `0040_notice_preferences`) creates no notice and therefore no push; the item itself still shows on Today and in its section. Task kinds keep their existing inbox preferences. The Notifications page in a dynamic links to these settings.

## Push delivery

Notices take their `push_seq` from the same sequence as the task inbox. The gateway push worker (docs/WEB_PUSH.md) asks the Instance for the highest eligible sequence per device and dynamic; `task_delivery_command` now returns the highest of the eligible task notice and the newest unread notice. Eligibility is unchanged: notifications enabled on the device (Profile) and for the dynamic (Notifications → How you are notified), quiet hours, an active household and no personal pause. One push covers everything newer; it carries no names or content and opens the app, which checks the session.

Push stays best effort. It is not suitable for safety actions.

## Native Android and iOS apps (planned)

The owner wants separate Android and iOS apps. The design keeps the server side independent of the delivery channel:

- **App shell.** Start with a thin native wrapper around the existing web app (#47), for example Capacitor, so screens, translations and authorization stay in one place. Sign-in uses the system browser (ASWebAuthenticationSession / Custom Tabs) against the gateway's OIDC flow; the app keeps only the gateway session cookie, never identity-provider tokens.
- **Device registration.** Extend `push_devices` with a provider (`webpush`, `fcm`, `apns`) and an encrypted provider token, bound to the session exactly like Web Push subscriptions today. Logout, revocation, expiry and suspension remove the device.
- **Delivery.** The gateway worker keeps the same scan and per-dynamic sequence. Only the final send step differs per provider: Web Push (VAPID), Firebase Cloud Messaging for Android and APNs for iOS. Payloads stay generic; a tap opens the app at the notifications page.
- **Operational secrets.** FCM service account and APNs key live in a root-owned file like `webPushFile`, outside Git, with an outbound allowlist for the provider hosts.
- **Store requirements.** Both stores require a privacy policy, an age rating for adult content and account deletion in the app; Pactaris already provides account deletion and personal export. App review of adult content needs to be checked before submission.

No native code is in the repository yet.
