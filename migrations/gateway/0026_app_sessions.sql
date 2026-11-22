-- Installed-app sessions (docs/PASSKEY_SIGN_IN.md): longer idle bound chosen at sign-in.
ALTER TABLE pactaris.login_attempts ADD COLUMN client text NOT NULL DEFAULT 'browser' CHECK(client IN ('browser','app'));
-- NULL keeps the configured browser idle bound for sessions created before this migration.
ALTER TABLE pactaris.sessions ADD COLUMN idle_seconds integer CHECK(idle_seconds BETWEEN 60 AND 31536000);
