-- Operator sign-in returns to the operator console (docs/OPERATOR_ACCESS.md). An `operator` attempt gets a
-- browser session, like before; only the page after the callback differs.
ALTER TABLE pactaris.login_attempts DROP CONSTRAINT login_attempts_client_check;
ALTER TABLE pactaris.login_attempts ADD CONSTRAINT login_attempts_client_check CHECK(client IN ('browser','app','operator'));
