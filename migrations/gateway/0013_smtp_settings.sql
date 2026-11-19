CREATE TABLE pactaris.smtp_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  ciphertext bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid NOT NULL REFERENCES pactaris.accounts(id)
);
