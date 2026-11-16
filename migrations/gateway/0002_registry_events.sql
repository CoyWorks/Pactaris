-- Operational metadata only; never store household names or relationship content.
CREATE TABLE pactaris.registry_events (
 id uuid PRIMARY KEY,
 instance_id uuid NOT NULL REFERENCES pactaris.instances(id),
 event_key text NOT NULL CHECK (event_key = 'registry.instanceRegistered'),
 created_at timestamptz NOT NULL DEFAULT now()
);
-- No runtime write grant: registration is an explicit operator action in this pilot.
