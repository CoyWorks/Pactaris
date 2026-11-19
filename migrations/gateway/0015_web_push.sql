CREATE TABLE pactaris.push_devices (
  endpoint_hash text PRIMARY KEY CHECK(length(endpoint_hash)=64),
  session_hash text UNIQUE NOT NULL REFERENCES pactaris.sessions(token_hash) ON DELETE CASCADE,
  ciphertext bytea NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  next_attempt_at timestamptz,
  queued_at timestamptz,
  last_requested_at timestamptz,
  attempts int NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 3)
);
CREATE INDEX push_devices_due ON pactaris.push_devices(next_attempt_at) WHERE next_attempt_at IS NOT NULL;
