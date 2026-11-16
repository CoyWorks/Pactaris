-- Identity metadata only. Neither field is an account key or membership grant.
-- Existing accounts deliberately start unknown; do not infer verification from
-- names, email-like subjects, or authentik user profile values during migration.
ALTER TABLE pactaris.accounts
  ADD COLUMN verified_email text,
  ADD COLUMN verified_email_asserted_at timestamptz,
  ADD CONSTRAINT accounts_verified_email_pair CHECK (
    (verified_email IS NULL AND verified_email_asserted_at IS NULL) OR
    (verified_email IS NOT NULL AND verified_email_asserted_at IS NOT NULL
      AND octet_length(verified_email) BETWEEN 3 AND 254)
  );
