-- Household plans (docs/HOUSEHOLD_PLANS.md): the gateway owns the plan and sends a signed, versioned
-- copy of the resulting limits. An update applies only if it is newer than the last one, so late or
-- repeated deliveries cannot roll a household back. Other capability keys are kept.
ALTER TABLE pactaris.household_entitlements ADD COLUMN plan_version bigint NOT NULL DEFAULT 0 CHECK(plan_version>=0);

CREATE FUNCTION pactaris.entitlements_apply(instance uuid,target uuid,next_version bigint,caps jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE applied boolean;current_version bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
  RETURN jsonb_build_object('householdId',target,'applied',false,'known',false);
 END IF;
 UPDATE pactaris.household_entitlements SET capabilities=capabilities||caps,version=version+1,plan_version=next_version,updated_at=now()
  WHERE household_id=target AND plan_version<next_version;
 applied=FOUND;
 SELECT plan_version INTO current_version FROM pactaris.household_entitlements WHERE household_id=target;
 RETURN jsonb_build_object('householdId',target,'applied',applied,'known',true,'planVersion',current_version);
END $$;
REVOKE ALL ON FUNCTION pactaris.entitlements_apply(uuid,uuid,bigint,jsonb) FROM PUBLIC;
