-- Gateway maintenance (docs/MAINTENANCE.md): run history, and how long closed reports are kept.
CREATE TABLE pactaris.maintenance_runs (
 id uuid PRIMARY KEY,task text NOT NULL CHECK(task IN ('gateway')),
 trigger text NOT NULL CHECK(trigger IN ('schedule','operator')),dry boolean NOT NULL DEFAULT false,
 operator_account_id uuid REFERENCES pactaris.accounts(id),
 started_at timestamptz NOT NULL DEFAULT now(),finished_at timestamptz,ok boolean,details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX maintenance_runs_recent ON pactaris.maintenance_runs(started_at DESC);
ALTER TABLE pactaris.platform_settings ADD COLUMN closed_report_days integer NOT NULL DEFAULT 365 CHECK(closed_report_days BETWEEN 30 AND 3650);
ALTER TABLE pactaris.operator_events DROP CONSTRAINT operator_events_action_check;
ALTER TABLE pactaris.operator_events ADD CONSTRAINT operator_events_action_check CHECK(action IN
 ('report.closed','report.reopened','report.noted','report.deleted','account.suspended','account.restored','settings.updated','operator.granted','operator.revoked','maintenance.run'));
