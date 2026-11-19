-- Minimal record that a complete personal export was streamed; no exported content.
CREATE TABLE pactaris.account_export_events (
 account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 exported_at timestamptz NOT NULL DEFAULT now(),
 complete boolean NOT NULL
);
CREATE INDEX account_export_events_account ON pactaris.account_export_events(account_id,exported_at);
