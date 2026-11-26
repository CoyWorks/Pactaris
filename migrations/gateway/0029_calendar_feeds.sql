-- Private calendar subscriptions (docs/CALENDAR_FEED.md): one per account and dynamic. Only the SHA-256
-- of the link secret is kept. Renewing replaces it; revoking deletes it.
CREATE TABLE pactaris.calendar_feeds (
 account_id uuid NOT NULL REFERENCES pactaris.accounts(id) ON DELETE CASCADE,household_id uuid NOT NULL,
 token_hash text NOT NULL UNIQUE CHECK(token_hash ~ '^[a-f0-9]{64}$'),created_at timestamptz NOT NULL DEFAULT now(),
 last_used_at timestamptz,PRIMARY KEY(account_id,household_id)
);
