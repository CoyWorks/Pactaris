-- Session-bound provider assertion. Old sessions deliberately have no proof.
ALTER TABLE pactaris.sessions ADD COLUMN recipient_email text, ADD COLUMN recipient_asserted_at timestamptz,
 ADD CONSTRAINT sessions_recipient_pair CHECK ((recipient_email IS NULL AND recipient_asserted_at IS NULL) OR
 (recipient_email IS NOT NULL AND recipient_asserted_at IS NOT NULL AND octet_length(recipient_email) BETWEEN 3 AND 254));
CREATE TABLE pactaris.invitation_routes (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.placements(household_id),
 instance_id uuid NOT NULL REFERENCES pactaris.instances(id),placement_version bigint NOT NULL,
 creator_membership_id uuid NOT NULL,creator_account_id uuid NOT NULL REFERENCES pactaris.accounts(id),create_operation_id uuid NOT NULL UNIQUE,
 request_hash text NOT NULL CHECK(length(request_hash)=64),created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pactaris.invitation_acceptances (
 id uuid PRIMARY KEY,invitation_id uuid NOT NULL REFERENCES pactaris.invitation_routes(id),
 account_id uuid NOT NULL REFERENCES pactaris.accounts(id),request_hash text NOT NULL CHECK(length(request_hash)=64),
 membership_id uuid,status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','left','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),next_check_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pactaris.invitation_acceptances(next_check_at) WHERE status='pending';
