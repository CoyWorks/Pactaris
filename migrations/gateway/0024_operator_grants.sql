-- Operators granted from the operator console (owner decision, 21 November 2026), next to the
-- allow-listed subjects in the gateway configuration, which stay the bootstrap and cannot be removed
-- from the console. Every grant still needs a fresh multi-factor sign-in to act. Reports can be deleted.
CREATE TABLE pactaris.operator_grants (
 account_id uuid PRIMARY KEY REFERENCES pactaris.accounts(id),
 granted_by uuid NOT NULL REFERENCES pactaris.accounts(id),
 granted_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE pactaris.operator_events DROP CONSTRAINT operator_events_action_check;
ALTER TABLE pactaris.operator_events ADD CONSTRAINT operator_events_action_check CHECK(action IN
 ('report.closed','report.reopened','report.noted','report.deleted','account.suspended','account.restored','settings.updated','operator.granted','operator.revoked'));
