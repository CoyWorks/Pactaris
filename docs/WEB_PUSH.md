# Optional Web Push pilot

The Gateway supports explicit browser opt-in and a generic test message. Keep the existing foreground inbox polling. Start with the test message to validate provider connectivity and shared-device behaviour independently of task delivery.

Add the optional absolute path `webPushFile` to the installed Gateway configuration. The Gateway and its worker must both read the file. Restrict it to the deployment owner and Gateway service group. It contains these JSON properties:

| Property | Value |
| --- | --- |
| `subject` | Operational contact in `mailto:` format |
| `publicKey` and `privateKey` | A persistent VAPID P-256 pair in base64url, generated with the installed `web-push generate-vapid-keys --json` executable |
| `encryptionKey` | An independent 32-byte secret as 64 lowercase hex digits, generated with `openssl rand -hex 32` |

Keep the private key and encryption key out of Git, shell history and operational logs. Restart Gateway and Gateway worker after adding the configuration. Keep the same keys across normal updates. Plan explicit browser re-enrollment after key rotation or changing the app origin. Limit outbound HTTPS to the providers in the code allowlist. Provider variants outside that list need a reviewed addition.

In account settings, enable device notifications and send a test. The worker persists and retries the test for a bounded window. The browser notification includes no household, sender or task data and opens the app root. Logout, session revocation, session expiry and account suspension remove or invalidate delivery for the associated session. The worker drops expired devices when a push provider responds with 404 or 410 and backs off on transient delivery failures. A generic push a provider already accepted may still arrive after sign-out. There is no binding to a different account until that account explicitly opts in on the device.

Verify with a browser on desktop, Android and a Home Screen installation on iOS/iPadOS. Open the site over HTTPS, enable permission from the in-app button, queue a test, close the page and open the notification. Repeat with permission blocked, explicit disable, and account switch on a shared device. On return, the user's data remains behind the normal session. Record browser version and provider separately. CI exercises the database and queue against a stub provider.

Household inbox events have not been connected to Push delivery. That path needs an exact membership check at send time, current preference and placement checks, and durable coalescing across Instances. Push remains best effort and is unsuitable for emergency actions.

## Participant task notices

Account settings enable a device. Task inbox preferences opt that membership into generic push and choose quiet hours in an IANA time zone. Quiet hours also support overnight intervals. The inbox remains authoritative and still works with push disabled.

The Gateway worker scans a bounded number of opted-in devices, one placement per device at a time, and retains one pending notice sequence per device and household. The Instance answers with a sequence only, using current membership, event settings, consent, pause and task access. Before each delivery the worker resolves placement again and checks current session and membership. The pending sequence survives a restart. Each successful delivery advances the watermark and coalesces older notices. Provider retries are bounded; in the event of a crash after provider acceptance, the provider may receive the same generic notification again.

Reminders are off by default. For newly scheduled participant tasks a durable Instance job can add a single inbox reminder during the last hour before a deadline once the task is available, provided the current agreement permits reminders and the assigned member opts in. The worker skips reminders after the deadline or for work that is closed, paused, revoked, or awaiting explicit acceptance. Opening push always takes the user to the app, which verifies the current session.
