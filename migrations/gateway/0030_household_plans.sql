-- Household plans (docs/HOUSEHOLD_PLANS.md, owner decisions 26 November 2026). A plan belongs to a dynamic.
-- `plan_credits` is the list members see: who added how many months of which level, and when (no prices).
-- At most one live subscription per dynamic; only its holder (or an operator) can stop it.
-- Only the household owner changes the level; `plan_level_changes` keeps who did that and when.
CREATE TABLE pactaris.household_plans (
 household_id uuid PRIMARY KEY REFERENCES pactaris.placements(household_id),
 tier text NOT NULL DEFAULT 'free' CHECK(tier IN ('free','level1','level2')),
 paid_until timestamptz,
 extra_members integer NOT NULL DEFAULT 0 CHECK(extra_members BETWEEN 0 AND 984),
 version bigint NOT NULL DEFAULT 1 CHECK(version>0),
 synced_version bigint NOT NULL DEFAULT 0,
 expired_at timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 CHECK((tier='free')=(paid_until IS NULL))
);
CREATE TABLE pactaris.plan_subscriptions (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.household_plans(household_id),
 holder_account_id uuid REFERENCES pactaris.accounts(id) ON DELETE SET NULL,
 tier text NOT NULL CHECK(tier IN ('level1','level2')),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','paused','stopped')),
 provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9_]{1,31}$'),provider_ref text CHECK(char_length(provider_ref) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(provider,provider_ref)
);
CREATE UNIQUE INDEX plan_subscriptions_one_live ON pactaris.plan_subscriptions(household_id) WHERE state IN ('active','paused');
CREATE TABLE pactaris.plan_credits (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.household_plans(household_id),
 account_id uuid REFERENCES pactaris.accounts(id) ON DELETE SET NULL,
 operator_account_id uuid REFERENCES pactaris.accounts(id) ON DELETE SET NULL,
 subscription_id uuid REFERENCES pactaris.plan_subscriptions(id),
 tier text NOT NULL CHECK(tier IN ('level1','level2')),months integer NOT NULL CHECK(months BETWEEN 1 AND 60),
 source text NOT NULL CHECK(source IN ('prepaid','subscription','operator')),
 provider_ref text CHECK(char_length(provider_ref) BETWEEN 1 AND 200),
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source,provider_ref)
);
CREATE INDEX ON pactaris.plan_credits(household_id,created_at DESC);
CREATE TABLE pactaris.plan_level_changes (
 id uuid PRIMARY KEY,household_id uuid NOT NULL REFERENCES pactaris.household_plans(household_id),
 account_id uuid REFERENCES pactaris.accounts(id) ON DELETE SET NULL,
 from_tier text NOT NULL CHECK(from_tier IN ('level1','level2')),to_tier text NOT NULL CHECK(to_tier IN ('level1','level2')),
 created_at timestamptz NOT NULL DEFAULT now(),CHECK(from_tier<>to_tier)
);
CREATE INDEX ON pactaris.plan_level_changes(household_id,created_at DESC);
ALTER TABLE pactaris.operator_events DROP CONSTRAINT operator_events_action_check;
ALTER TABLE pactaris.operator_events ADD CONSTRAINT operator_events_action_check CHECK(action IN ('report.closed','report.reopened','report.noted','report.deleted',
 'account.suspended','account.restored','settings.updated','operator.granted','operator.revoked','maintenance.run',
 'plan.granted','plan.members','subscription.paused','subscription.resumed','subscription.stopped'));
-- "Need more members?" is a report category; the report carries the dynamic's ID.
ALTER TABLE pactaris.abuse_reports DROP CONSTRAINT abuse_reports_category_check;
ALTER TABLE pactaris.abuse_reports ADD CONSTRAINT abuse_reports_category_check CHECK(category IN ('bug','account','suggestion','minorSafety','members','other',
 'harassment','unwantedInvitation','nonConsensual','impersonation','spam'));
