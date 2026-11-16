CREATE SCHEMA IF NOT EXISTS pactaris;
CREATE TABLE pactaris.households (
 id uuid PRIMARY KEY, instance_id uuid NOT NULL, display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','closed')),
 safety_version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pactaris.memberships (
 household_id uuid NOT NULL REFERENCES pactaris.households(id), id uuid NOT NULL, account_id uuid NOT NULL,
 status text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','left','revoked')),
 technical_role text NOT NULL DEFAULT 'participant' CHECK (technical_role IN ('owner','admin','participant')),
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (household_id,id), UNIQUE (household_id,account_id)
);
CREATE INDEX ON pactaris.memberships (account_id,household_id) WHERE status='active';
CREATE TABLE pactaris.relationships (
 household_id uuid NOT NULL REFERENCES pactaris.households(id), id uuid NOT NULL, label text NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','active','ended')),
 visibility text NOT NULL DEFAULT 'participants' CHECK (visibility IN ('participants','household')),
 version bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (household_id,id)
);
CREATE TABLE pactaris.relationship_participants (
 household_id uuid NOT NULL, relationship_id uuid NOT NULL, membership_id uuid NOT NULL,
 accepted boolean NOT NULL DEFAULT false, PRIMARY KEY (household_id,relationship_id,membership_id),
 FOREIGN KEY (household_id,relationship_id) REFERENCES pactaris.relationships(household_id,id),
 FOREIGN KEY (household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.dynamic_roles (
 household_id uuid NOT NULL REFERENCES pactaris.households(id), id uuid NOT NULL, label text NOT NULL,
 PRIMARY KEY (household_id,id)
);
CREATE TABLE pactaris.relationship_roles (
 household_id uuid NOT NULL, id uuid NOT NULL, relationship_id uuid NOT NULL, membership_id uuid NOT NULL,
 role_id uuid NOT NULL, counterpart_membership_id uuid, context text NOT NULL DEFAULT '',
 PRIMARY KEY (household_id,id),
 FOREIGN KEY (household_id,relationship_id,membership_id) REFERENCES pactaris.relationship_participants(household_id,relationship_id,membership_id),
 FOREIGN KEY (household_id,relationship_id,counterpart_membership_id) REFERENCES pactaris.relationship_participants(household_id,relationship_id,membership_id),
 FOREIGN KEY (household_id,role_id) REFERENCES pactaris.dynamic_roles(household_id,id),
 CHECK (counterpart_membership_id IS NULL OR counterpart_membership_id<>membership_id)
);
CREATE TABLE pactaris.consent_records (
 household_id uuid NOT NULL, id uuid NOT NULL, membership_id uuid NOT NULL, version bigint NOT NULL,
 status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','accepted','declined','withdrawn')),
 scope jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (household_id,id),
 FOREIGN KEY (household_id,membership_id) REFERENCES pactaris.memberships(household_id,id)
);
CREATE TABLE pactaris.audit_events (
 household_id uuid NOT NULL REFERENCES pactaris.households(id), id uuid NOT NULL, actor_account_id uuid,
 event_key text NOT NULL, resource_id uuid, parameters jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (household_id,id)
);
CREATE TABLE pactaris.household_entitlements (
 household_id uuid PRIMARY KEY REFERENCES pactaris.households(id), version bigint NOT NULL CHECK (version>0),
 capabilities jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE pactaris.delegation_uses (jti uuid PRIMARY KEY, expires_at timestamptz NOT NULL);

-- Identity is set only after signature/audience validation by the private API.
-- Membership can be checked before selecting tenant context; only the subject's rows are visible.
ALTER TABLE pactaris.memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_self ON pactaris.memberships FOR SELECT USING (
 account_id::text=current_setting('pactaris.account_id',true)
);
CREATE FUNCTION pactaris.active_household(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY INVOKER
SET search_path=pg_catalog,pactaris AS $$
 SELECT target::text=current_setting('pactaris.household_id',true) AND EXISTS (
  SELECT 1 FROM pactaris.memberships m WHERE m.household_id=target
   AND m.account_id::text=current_setting('pactaris.account_id',true) AND m.status='active'
 )
$$;
ALTER TABLE pactaris.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.households FORCE ROW LEVEL SECURITY;
CREATE POLICY households_member ON pactaris.households FOR SELECT USING (pactaris.active_household(id));
-- These foundations are not exposed by a domain API in this release.
-- Private relationship/consent data is denied until resource-visibility policies ship.
ALTER TABLE pactaris.relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationships FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_participants FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.dynamic_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.dynamic_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.relationship_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.consent_records FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.audit_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.audit_events FORCE ROW LEVEL SECURITY;
ALTER TABLE pactaris.household_entitlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.household_entitlements FORCE ROW LEVEL SECURITY;
CREATE POLICY entitlements_member ON pactaris.household_entitlements FOR SELECT USING (pactaris.active_household(household_id));
