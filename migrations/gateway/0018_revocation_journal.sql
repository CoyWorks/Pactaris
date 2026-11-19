-- Copy of each Instance's content-free revocation journal, kept outside the
-- Instance database so a restored Instance snapshot can replay later revocations.
CREATE TABLE pactaris.revocation_journal (
 instance_id uuid NOT NULL REFERENCES pactaris.instances(id),
 entry_id uuid NOT NULL,
 household_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind ~ '^[a-zA-Z]{1,24}\.[a-zA-Z]{1,24}$'),
 subject jsonb NOT NULL CHECK(jsonb_typeof(subject)='object' AND octet_length(subject::text)<=1024),
 occurred_at timestamptz NOT NULL,
 received_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(instance_id,entry_id)
);
CREATE INDEX revocation_journal_household ON pactaris.revocation_journal(instance_id,household_id,occurred_at);
