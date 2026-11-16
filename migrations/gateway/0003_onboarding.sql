-- Routing/operation metadata only. Household names remain in the home Instance.
CREATE TABLE pactaris.onboarding_operations (
 id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 household_id uuid NOT NULL, instance_id uuid NOT NULL REFERENCES pactaris.instances(id),
 placement_version bigint NOT NULL DEFAULT 1 CHECK(placement_version>0),
 action text NOT NULL CHECK(action IN ('create','leave')),
 request_hash text NOT NULL CHECK(request_hash ~ '^[a-f0-9]{64}$'),
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','complete','released')),
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 next_check_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pactaris.onboarding_operations(account_id,status,action);
CREATE INDEX ON pactaris.onboarding_operations(next_check_at) WHERE status='pending';
CREATE TABLE pactaris.onboarding_events (
 operation_id uuid NOT NULL REFERENCES pactaris.onboarding_operations(id),
 event_key text NOT NULL CHECK(event_key IN ('onboarding.reserved','onboarding.complete','onboarding.released')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(operation_id,event_key)
);
