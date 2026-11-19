-- Abuse reports and limited operator account actions (docs/MODERATION.md). Reports hold
-- only what the reporter chose to write; operators get no household content.
CREATE TABLE pactaris.abuse_reports (
 id uuid PRIMARY KEY,
 reporter_account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 category text NOT NULL CHECK(category IN ('harassment','unwantedInvitation','nonConsensual','minorSafety','impersonation','spam','other')),
 household_id uuid,
 details text NOT NULL CHECK(char_length(details) BETWEEN 1 AND 1000),
 created_at timestamptz NOT NULL DEFAULT now(),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','closed')),
 resolution text CHECK(resolution IN ('actioned','noAction','duplicate')),
 closed_at timestamptz,
 closed_by uuid REFERENCES pactaris.accounts(id),
 CHECK((state='open')=(resolution IS NULL AND closed_at IS NULL AND closed_by IS NULL))
);
CREATE INDEX abuse_reports_open ON pactaris.abuse_reports(state,created_at);
CREATE TABLE pactaris.operator_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 operator_account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 action text NOT NULL CHECK(action IN ('report.closed','account.suspended','account.restored')),
 target_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
