-- Gateway cannot infer Instance membership identity from account/household pairs.
-- Legacy rows stay unknown until a verified private receipt/summary supplies it.
ALTER TABLE pactaris.account_households ADD COLUMN membership_id uuid;
ALTER TABLE pactaris.onboarding_operations ADD COLUMN membership_id uuid;
