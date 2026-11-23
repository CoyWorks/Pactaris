-- Identity's internal user number for self-service sign-in devices (docs/ACCOUNT_SECURITY.md).
ALTER TABLE pactaris.accounts ADD COLUMN identity_user_id bigint CHECK(identity_user_id>0);
