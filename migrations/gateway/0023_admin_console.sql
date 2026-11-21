-- Operator console (docs/OPERATOR_ACCESS.md, docs/MODERATION.md): platform-wide settings, internal
-- notes on reports, reopening reports, and audit entries for every operator change.
CREATE TABLE pactaris.platform_settings (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 registration text NOT NULL DEFAULT 'open' CHECK(registration IN ('open','closed')),
 announcement text CHECK(announcement IS NULL OR char_length(announcement) BETWEEN 1 AND 300),
 announcement_level text NOT NULL DEFAULT 'info' CHECK(announcement_level IN ('info','warning')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_by uuid REFERENCES pactaris.accounts(id),
 updated_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO pactaris.platform_settings(singleton) VALUES(true);
CREATE TABLE pactaris.report_notes (
 id uuid PRIMARY KEY,
 report_id uuid NOT NULL REFERENCES pactaris.abuse_reports(id),
 author_account_id uuid NOT NULL REFERENCES pactaris.accounts(id),
 body text NOT NULL CHECK(char_length(body) BETWEEN 1 AND 2000),
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX report_notes_report ON pactaris.report_notes(report_id,created_at);
CREATE INDEX abuse_reports_created ON pactaris.abuse_reports(created_at DESC,id);
CREATE INDEX accounts_created ON pactaris.accounts(created_at DESC,id);
ALTER TABLE pactaris.operator_events DROP CONSTRAINT operator_events_action_check;
ALTER TABLE pactaris.operator_events ADD CONSTRAINT operator_events_action_check CHECK(action IN
 ('report.closed','report.reopened','report.noted','account.suspended','account.restored','settings.updated'));
CREATE INDEX operator_events_created ON pactaris.operator_events(created_at DESC,id);
