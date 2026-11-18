CREATE TABLE pactaris.invitation_mail (
 invitation_id uuid PRIMARY KEY REFERENCES pactaris.invitation_routes(id) ON DELETE CASCADE,
 status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','inactive')),
 payload bytea,
 expires_at timestamptz NOT NULL,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
 CHECK ((status='queued')=(payload IS NOT NULL))
);
CREATE INDEX ON pactaris.invitation_mail(next_attempt_at) WHERE status='queued';
