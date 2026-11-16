-- Minimal operation/routing metadata; aliases and household content stay local.
CREATE TABLE pactaris.membership_operations (
 id uuid PRIMARY KEY,actor_account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 household_id uuid NOT NULL REFERENCES pactaris.placements(household_id),
 instance_id uuid NOT NULL REFERENCES pactaris.instances(id),placement_version bigint NOT NULL,
 actor_membership_id uuid NOT NULL,action text NOT NULL CHECK(action IN
 ('memberAlias','memberRemove','ownerOffer','ownerAccept','ownerDecline','ownerCancel')),
 request_hash text NOT NULL CHECK(length(request_hash)=64),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','rejected')),
 created_at timestamptz NOT NULL DEFAULT now(),next_check_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pactaris.membership_operations(next_check_at) WHERE status='pending';
