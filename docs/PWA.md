# Installable mobile web app

The public gateway serves the manifest and service worker on the configured Pactaris origin. The manifest starts at the start page, which opens the only dynamic directly and uses standalone display. Private Instances expose their existing health and application routes independently.

The worker passes application navigations to the network. If a navigation fails, it returns a generic localized offline page built into the worker. It does not intercept API calls, sign-in callbacks, mutations or static asset requests. Gateway HTML and API responses use `Cache-Control: no-store`. The browser can cache the existing fingerprinted public build assets. The worker creates no Cache Storage entries and queues no writes. It keeps the previous worker active while its controlled tabs remain open.

When the browser reports a lost connection, the open app replaces its workspace with generic offline status. When it reconnects, the app reloads session and household data through the gateway. The app hides pages kept in the browser history cache and reloads them when restored. A detected account switch reloads the workspace before rendering the new account's data. After a confirmed sign-out, open app tabs in the same browser storage partition hide their current view and reload on a same-origin signal. The signal carries no account or household identifiers. Browsers without inter-tab messaging use the existing resume and polling checks.

## Verify on mobile

- On Android Chrome, open the public app and install it from the browser. On iOS Safari, use Add to Home Screen and launch it from the new icon. Verify the app opens at the public origin.
- Open a private household, lose connectivity and check that the generic offline state replaces the workspace. Reopen the installed app offline and check the generic fallback. Reconnect and verify the session and allowed households are loaded again.
- Open the household in two tabs in the same browser context. Sign out in the first, check that the second hides its workspace and reloads, then use Back in the first. Then sign in with another account and verify only that account's households appear.
- After a deploy, close the installed app and its browser tabs, then reopen. Verify the current app and worker load over HTTPS.

Target-device and accessibility acceptance remain part of #14. Push subscriptions are tracked in #23.
