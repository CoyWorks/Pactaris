-- Account-wide deletion (docs/ACCOUNT_DELETION.md). A deleting account cannot sign in
-- or hold sessions. Each registered Instance must acknowledge erasure before the
-- account row is reduced to an unlinkable marker.
ALTER TABLE pactaris.accounts DROP CONSTRAINT accounts_status_check;
ALTER TABLE pactaris.accounts ADD CONSTRAINT accounts_status_check CHECK (status IN ('active','suspended','deleting','deleted'));
CREATE TABLE pactaris.account_deletions (
 account_id uuid PRIMARY KEY REFERENCES pactaris.accounts(id),
 operation_id uuid NOT NULL UNIQUE,
 requested_at timestamptz NOT NULL DEFAULT now(),
 completed_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts>=0),
 next_attempt_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_deletions_pending ON pactaris.account_deletions(next_attempt_at) WHERE completed_at IS NULL;
CREATE TABLE pactaris.account_deletion_instances (
 account_id uuid NOT NULL REFERENCES pactaris.account_deletions(account_id),
 instance_id uuid NOT NULL REFERENCES pactaris.instances(id),
 acknowledged_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(account_id,instance_id)
);
