ALTER TABLE pactaris.accounts
 ADD COLUMN locale_format text,
 ADD COLUMN time_zone text,
 ADD CONSTRAINT account_presentation_pair CHECK (
  (locale_format IS NULL AND time_zone IS NULL) OR
  (locale_format IS NOT NULL AND time_zone IS NOT NULL
   AND char_length(locale_format) BETWEEN 1 AND 64 AND char_length(time_zone) BETWEEN 1 AND 100)
 );
CREATE TABLE pactaris.account_presentation_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 account_id uuid NOT NULL REFERENCES pactaris.accounts(id) ON DELETE CASCADE,
 changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON pactaris.account_presentation_events(account_id,changed_at);
