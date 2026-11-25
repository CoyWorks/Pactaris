-- Owner decision, 25 November 2026: Pactaris is for adults only. Every account confirms once that the
-- person is 18 or older before creating or joining a dynamic (docs/AGE_CONFIRMATION.md).
ALTER TABLE pactaris.accounts ADD COLUMN adult_confirmed_at timestamptz;
