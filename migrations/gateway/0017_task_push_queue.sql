ALTER TABLE pactaris.push_devices ADD COLUMN scan_after timestamptz NOT NULL DEFAULT now(),
 ADD COLUMN scan_cursor uuid;
CREATE INDEX push_devices_scan ON pactaris.push_devices(scan_after);

CREATE TABLE pactaris.task_push_scopes (
 endpoint_hash text NOT NULL REFERENCES pactaris.push_devices(endpoint_hash) ON DELETE CASCADE,
 session_hash text NOT NULL REFERENCES pactaris.sessions(token_hash) ON DELETE CASCADE,
 household_id uuid NOT NULL REFERENCES pactaris.placements(household_id) ON DELETE CASCADE,
 instance_id uuid NOT NULL REFERENCES pactaris.instances(id),
 membership_id uuid NOT NULL,
 last_seq bigint NOT NULL DEFAULT 0 CHECK(last_seq>=0),
 pending_seq bigint CHECK(pending_seq>last_seq),
 next_attempt_at timestamptz,
 expires_at timestamptz,
 attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3),
 PRIMARY KEY(endpoint_hash,household_id)
);
CREATE INDEX task_push_pending ON pactaris.task_push_scopes(next_attempt_at) WHERE pending_seq IS NOT NULL;
