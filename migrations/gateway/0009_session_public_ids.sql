ALTER TABLE pactaris.sessions ADD COLUMN public_id uuid NOT NULL DEFAULT gen_random_uuid();
CREATE UNIQUE INDEX ON pactaris.sessions(account_id,public_id);
