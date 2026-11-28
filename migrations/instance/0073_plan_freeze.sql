-- Pausing the excess after a downgrade (docs/HOUSEHOLD_PLANS.md, owner decisions 27-28 November 2026).
-- Only what runs by itself is paused ("frozen"): repeating tasks (Dom series and personal series), Dom-set
-- habits, routines and shop listings. One-off tasks and catalog items are never frozen.
-- * When the limits drop below what is in use, the newest items above the limit are frozen; the oldest stay.
-- * When there is room again (an upgrade, or something archived or ended), frozen items come back by
--   themselves, oldest first, from the current period: nothing is caught up and nothing is punished.
-- * The person responsible can swap which items stay active: the Dom for Dom series, habits and shop
--   listings, the person themselves for personal series and routines.
-- * Frozen items cannot be edited or resumed; ending, archiving, stopping and unlisting always work.
-- Nothing is deleted. A frozen shop listing waits in shop_listings_frozen, so the shop does not offer it.

ALTER TABLE pactaris.task_series ADD COLUMN plan_frozen boolean NOT NULL DEFAULT false,ADD COLUMN plan_since timestamptz NOT NULL DEFAULT now();
ALTER TABLE pactaris.personal_task_series ADD COLUMN plan_frozen boolean NOT NULL DEFAULT false,ADD COLUMN plan_since timestamptz NOT NULL DEFAULT now();
ALTER TABLE pactaris.authority_habits ADD COLUMN plan_frozen boolean NOT NULL DEFAULT false,ADD COLUMN plan_frozen_state text CHECK(plan_frozen_state IN ('active','paused'));
ALTER TABLE pactaris.routines ADD COLUMN plan_frozen boolean NOT NULL DEFAULT false,ADD COLUMN plan_frozen_state text CHECK(plan_frozen_state IN ('draft','active','paused'));
ALTER TABLE pactaris.shop_listings ADD COLUMN plan_since timestamptz NOT NULL DEFAULT now();
CREATE TABLE pactaris.shop_listings_frozen (
 household_id uuid NOT NULL,item_id uuid NOT NULL,holder_id uuid NOT NULL,auto_grant boolean NOT NULL,weekly_limit integer,
 version bigint NOT NULL,plan_since timestamptz NOT NULL,frozen_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(household_id,item_id),FOREIGN KEY(household_id,item_id) REFERENCES pactaris.catalog_items(household_id,id),
 FOREIGN KEY(household_id,holder_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.shop_listings_frozen ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.shop_listings_frozen FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.shop_listings_frozen FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

-- A revision of a personal series keeps the original's place in line.
CREATE FUNCTION pactaris.plan_personal_series_since() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE previous pactaris.personal_task_series;
BEGIN
 SELECT * INTO previous FROM pactaris.personal_task_series WHERE household_id=NEW.household_id AND id=NEW.id AND version=NEW.version-1;
 IF FOUND THEN
  IF previous.plan_frozen AND current_setting('pactaris.plan_rebalancing',true) IS DISTINCT FROM 'on' THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.capacity'; END IF;
  NEW.plan_since=previous.plan_since;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_personal_series_since() FROM PUBLIC;
CREATE TRIGGER plan_personal_series_since BEFORE INSERT ON pactaris.personal_task_series FOR EACH ROW EXECUTE FUNCTION pactaris.plan_personal_series_since();

-- Shop items count active and frozen listings together, so a new listing waits while anything is frozen.
CREATE OR REPLACE FUNCTION pactaris.plan_used(target uuid,key text,person uuid) RETURNS integer
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT CASE key
  WHEN 'oneoff.open.max' THEN
   (SELECT count(*) FROM pactaris.tasks WHERE household_id=target AND state='open' AND personal_series_id IS NULL
     AND coalesce(assignee_membership_id,creator_membership_id)=person)
   +(SELECT count(*) FROM pactaris.partner_tasks WHERE household_id=target AND series_id IS NULL AND assignee_id=person
     AND state NOT IN ('done','declined','cancelled'))
  WHEN 'series.active.max' THEN
   (SELECT count(*) FROM pactaris.task_series WHERE household_id=target AND assignee_id=person AND state IN ('active','blocked'))
   +(SELECT count(*) FROM pactaris.personal_task_series WHERE household_id=target AND creator_id=person AND state IN ('active','blocked'))
  WHEN 'habits.assigned.max' THEN
   (SELECT count(*) FROM pactaris.authority_habits WHERE household_id=target AND subject_id=person AND state IN ('active','paused'))
  WHEN 'routines.active.max' THEN
   (SELECT count(*) FROM pactaris.routines WHERE household_id=target AND creator_membership_id=person AND state IN ('draft','active','paused'))
  WHEN 'catalog.rewards.max' THEN
   (SELECT count(*) FROM pactaris.catalog_items i JOIN pactaris.catalog_versions v ON v.household_id=i.household_id AND v.item_id=i.id AND v.version=i.version
     WHERE i.household_id=target AND i.state='draft' AND coalesce(v.fields->>'kind','reward')<>'consequence')
  WHEN 'catalog.punishments.max' THEN
   (SELECT count(*) FROM pactaris.catalog_items i JOIN pactaris.catalog_versions v ON v.household_id=i.household_id AND v.item_id=i.id AND v.version=i.version
     WHERE i.household_id=target AND i.state='draft' AND v.fields->>'kind'='consequence')
  WHEN 'shop.items.max' THEN
   (SELECT count(*) FROM pactaris.shop_listings WHERE household_id=target)
   +(SELECT count(*) FROM pactaris.shop_listings_frozen WHERE household_id=target)
  WHEN 'members.active.max' THEN
   (SELECT count(*) FROM pactaris.memberships WHERE household_id=target AND status='active')
  ELSE 0 END::integer
$$;
-- Unfreezing moves a listing back; that is not a new listing.
CREATE OR REPLACE FUNCTION pactaris.plan_shop_capacity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF current_setting('pactaris.plan_rebalancing',true)='on' THEN RETURN NEW;END IF;
 IF EXISTS(SELECT 1 FROM pactaris.shop_listings WHERE household_id=NEW.household_id AND item_id=NEW.item_id) THEN RETURN NEW;END IF;
 -- Listing an item whose listing is frozen would bring it back around the limit.
 IF EXISTS(SELECT 1 FROM pactaris.shop_listings_frozen WHERE household_id=NEW.household_id AND item_id=NEW.item_id) THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.limit';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||NEW.household_id::text,0));
 IF pactaris.plan_used(NEW.household_id,'shop.items.max',NULL)>=pactaris.plan_limit(NEW.household_id,'shop.items.max') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.limit';
 END IF;
 RETURN NEW;
END $$;

-- Everything that can be frozen, with the person it counts for and who may choose for it.
CREATE FUNCTION pactaris.plan_freezable(target uuid)
RETURNS TABLE(kind text,item uuid,person uuid,since timestamptz,frozen boolean,title text,chooser uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT 'series',s.id,s.assignee_id,s.plan_since,s.plan_frozen,s.fields->>'title',s.creator_id
  FROM pactaris.task_series s WHERE s.household_id=target AND s.state IN ('active','blocked')
 UNION ALL
 SELECT 'series',p.id,p.creator_id,p.plan_since,p.plan_frozen,p.fields->>'title',p.creator_id
  FROM pactaris.personal_task_series p WHERE p.household_id=target AND p.state IN ('active','blocked')
 UNION ALL
 SELECT 'habit',a.id,a.subject_id,a.created_at,a.plan_frozen,a.title,a.holder_id
  FROM pactaris.authority_habits a WHERE a.household_id=target AND a.state IN ('active','paused')
 UNION ALL
 SELECT 'routine',r.id,r.creator_membership_id,r.created_at,r.plan_frozen,
   (SELECT v.fields->>'title' FROM pactaris.routine_revisions v WHERE v.household_id=r.household_id AND v.routine_id=r.id AND v.revision=r.revision),
   r.creator_membership_id
  FROM pactaris.routines r WHERE r.household_id=target AND r.state IN ('draft','active','paused')
 UNION ALL
 SELECT 'shop',l.item_id,NULL::uuid,l.plan_since,false,v.fields->>'title',l.holder_id
  FROM pactaris.shop_listings l JOIN pactaris.catalog_items c ON c.household_id=l.household_id AND c.id=l.item_id
  JOIN pactaris.catalog_versions v ON v.household_id=c.household_id AND v.item_id=c.id AND v.version=c.version
  WHERE l.household_id=target
 UNION ALL
 SELECT 'shop',f.item_id,NULL::uuid,f.plan_since,true,v.fields->>'title',f.holder_id
  FROM pactaris.shop_listings_frozen f JOIN pactaris.catalog_items c ON c.household_id=f.household_id AND c.id=f.item_id AND c.state='draft'
  JOIN pactaris.catalog_versions v ON v.household_id=c.household_id AND v.item_id=c.id AND v.version=c.version
  WHERE f.household_id=target
$$;
REVOKE ALL ON FUNCTION pactaris.plan_freezable(uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.plan_kind_key(kind text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE kind WHEN 'series' THEN 'series.active.max' WHEN 'habit' THEN 'habits.assigned.max'
  WHEN 'routine' THEN 'routines.active.max' WHEN 'shop' THEN 'shop.items.max' END
$$;

-- Freezes or unfreezes one item, with its effect. Only called with plan_rebalancing on.
CREATE FUNCTION pactaris.plan_set_frozen(target uuid,item_kind text,target_item uuid,to_freeze boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE l pactaris.shop_listings;f pactaris.shop_listings_frozen;
BEGIN
 IF item_kind='series' THEN
  UPDATE pactaris.task_series SET plan_frozen=to_freeze WHERE household_id=target AND id=target_item AND state IN ('active','blocked');
  IF FOUND THEN
   -- A frozen Dom series generates nothing; when it comes back it starts from today (no catch-up).
   UPDATE pactaris.task_generation_jobs SET run_after=CASE WHEN to_freeze THEN 'infinity'::timestamptz ELSE now() END
    WHERE household_id=target AND series_id=target_item AND state='pending';
  ELSE
   UPDATE pactaris.personal_task_series SET plan_frozen=to_freeze,
    run_after=CASE WHEN to_freeze THEN 'infinity'::timestamptz ELSE now() END,
    cursor_date=CASE WHEN to_freeze THEN cursor_date ELSE greatest(cursor_date,(now() AT TIME ZONE (schedule->>'timeZone'))::date) END
    WHERE household_id=target AND id=target_item AND state IN ('active','blocked');
  END IF;
 ELSIF item_kind='habit' THEN
  IF to_freeze THEN
   UPDATE pactaris.authority_habits SET plan_frozen=true,plan_frozen_state=state,state='paused'
    WHERE household_id=target AND id=target_item AND state IN ('active','paused') AND NOT plan_frozen;
  ELSE
   -- Like resuming: the current period is the first one evaluated again.
   UPDATE pactaris.authority_habits SET plan_frozen=false,state=coalesce(plan_frozen_state,state),plan_frozen_state=NULL,
    skip_through=CASE WHEN plan_frozen_state='active' THEN greatest(skip_through,pactaris.habit_period_start(period,time_zone,now())) ELSE skip_through END,
    next_period=CASE WHEN plan_frozen_state='active' THEN pactaris.habit_period_start(period,time_zone,now()) ELSE next_period END
    WHERE household_id=target AND id=target_item AND plan_frozen;
  END IF;
 ELSIF item_kind='routine' THEN
  IF to_freeze THEN
   UPDATE pactaris.routines SET plan_frozen=true,plan_frozen_state=state,state=CASE WHEN state='active' THEN 'paused' ELSE state END
    WHERE household_id=target AND id=target_item AND state IN ('draft','active','paused') AND NOT plan_frozen;
  ELSE
   UPDATE pactaris.routines SET plan_frozen=false,state=coalesce(plan_frozen_state,state),plan_frozen_state=NULL
    WHERE household_id=target AND id=target_item AND plan_frozen;
  END IF;
 ELSIF item_kind='shop' THEN
  IF to_freeze THEN
   DELETE FROM pactaris.shop_listings WHERE household_id=target AND item_id=target_item RETURNING * INTO l;
   IF l.item_id IS NOT NULL THEN
    INSERT INTO pactaris.shop_listings_frozen(household_id,item_id,holder_id,auto_grant,weekly_limit,version,plan_since)
     VALUES(l.household_id,l.item_id,l.holder_id,l.auto_grant,l.weekly_limit,l.version,l.plan_since);
   END IF;
  ELSE
   DELETE FROM pactaris.shop_listings_frozen WHERE household_id=target AND item_id=target_item RETURNING * INTO f;
   IF f.item_id IS NOT NULL THEN
    INSERT INTO pactaris.shop_listings(household_id,item_id,holder_id,auto_grant,weekly_limit,version,plan_since)
     VALUES(f.household_id,f.item_id,f.holder_id,f.auto_grant,f.weekly_limit,f.version+1,f.plan_since);
   END IF;
  END IF;
 END IF;
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_set_frozen(uuid,text,uuid,boolean) FROM PUBLIC;

-- Brings each person (and the dynamic, for the shop) back within the limits: freezes the newest active
-- items above a limit, and unfreezes the oldest frozen ones while there is room.
CREATE FUNCTION pactaris.plan_rebalance(target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE g record;x record;cap integer;active integer;previous text;
BEGIN
 previous=current_setting('pactaris.plan_rebalancing',true);
 PERFORM set_config('pactaris.plan_rebalancing','on',true);
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 FOR g IN SELECT DISTINCT p.kind,p.person FROM pactaris.plan_freezable(target) p LOOP
  cap=pactaris.plan_limit(target,pactaris.plan_kind_key(g.kind));
  SELECT count(*) INTO active FROM pactaris.plan_freezable(target) p WHERE p.kind=g.kind AND p.person IS NOT DISTINCT FROM g.person AND NOT p.frozen;
  IF active>cap THEN
   FOR x IN SELECT p.item FROM pactaris.plan_freezable(target) p WHERE p.kind=g.kind AND p.person IS NOT DISTINCT FROM g.person AND NOT p.frozen
    ORDER BY p.since DESC,p.item DESC LIMIT active-cap LOOP
    PERFORM pactaris.plan_set_frozen(target,g.kind,x.item,true);
   END LOOP;
  ELSIF active<cap THEN
   FOR x IN SELECT p.item FROM pactaris.plan_freezable(target) p WHERE p.kind=g.kind AND p.person IS NOT DISTINCT FROM g.person AND p.frozen
    ORDER BY p.since,p.item LIMIT cap-active LOOP
    PERFORM pactaris.plan_set_frozen(target,g.kind,x.item,false);
   END LOOP;
  END IF;
 END LOOP;
 PERFORM set_config('pactaris.plan_rebalancing',coalesce(previous,'off'),true);
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_rebalance(uuid) FROM PUBLIC;

-- A new plan rebalances right away.
CREATE OR REPLACE FUNCTION pactaris.entitlements_apply(instance uuid,target uuid,next_version bigint,caps jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE applied boolean;current_version bigint;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
  RETURN jsonb_build_object('householdId',target,'applied',false,'known',false);
 END IF;
 UPDATE pactaris.household_entitlements SET capabilities=capabilities||caps,version=version+1,plan_version=next_version,updated_at=now()
  WHERE household_id=target AND plan_version<next_version;
 applied=FOUND;
 IF applied THEN PERFORM pactaris.plan_rebalance(target); END IF;
 SELECT plan_version INTO current_version FROM pactaris.household_entitlements WHERE household_id=target;
 RETURN jsonb_build_object('householdId',target,'applied',applied,'known',true,'planVersion',current_version);
END $$;

-- Room appears when something ends, is archived, stopped or unlisted.
CREATE FUNCTION pactaris.plan_room_changed() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
BEGIN
 IF current_setting('pactaris.plan_rebalancing',true)='on' THEN RETURN NULL;END IF;
 IF TG_TABLE_NAME='catalog_items' THEN
  IF NEW.state='archived' THEN DELETE FROM pactaris.shop_listings_frozen WHERE household_id=NEW.household_id AND item_id=NEW.id; END IF;
 END IF;
 PERFORM pactaris.plan_rebalance(coalesce(NEW.household_id,OLD.household_id));
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_room_changed() FROM PUBLIC;
CREATE TRIGGER plan_room_series AFTER UPDATE OF state ON pactaris.task_series FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state) EXECUTE FUNCTION pactaris.plan_room_changed();
CREATE TRIGGER plan_room_personal AFTER UPDATE OF state ON pactaris.personal_task_series FOR EACH ROW WHEN (OLD.state IS DISTINCT FROM NEW.state AND NEW.state<>'superseded') EXECUTE FUNCTION pactaris.plan_room_changed();
CREATE TRIGGER plan_room_habit AFTER UPDATE OF state ON pactaris.authority_habits FOR EACH ROW WHEN (NEW.state='archived' AND OLD.state<>'archived') EXECUTE FUNCTION pactaris.plan_room_changed();
CREATE TRIGGER plan_room_routine AFTER UPDATE OF state ON pactaris.routines FOR EACH ROW WHEN (NEW.state='archived' AND OLD.state<>'archived') EXECUTE FUNCTION pactaris.plan_room_changed();
CREATE TRIGGER plan_room_shop AFTER DELETE ON pactaris.shop_listings FOR EACH ROW EXECUTE FUNCTION pactaris.plan_room_changed();
CREATE TRIGGER plan_room_catalog AFTER UPDATE OF state ON pactaris.catalog_items FOR EACH ROW WHEN (NEW.state='archived' AND OLD.state<>'archived') EXECUTE FUNCTION pactaris.plan_room_changed();

-- Frozen items cannot be edited or resumed; ending, archiving, stopping and breaks always work.
CREATE FUNCTION pactaris.plan_frozen_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE kept text[]:=ARRAY['state','version','next_period','skip_through','breaks','plan_frozen','plan_frozen_state'];
BEGIN
 IF current_setting('pactaris.plan_rebalancing',true)='on' THEN RETURN NEW;END IF;
 IF TG_TABLE_NAME='authority_habits' THEN
  IF OLD.plan_frozen AND NEW.state<>'archived' AND (NEW.state='active' OR (to_jsonb(NEW)-kept)<>(to_jsonb(OLD)-kept)) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.limit'; END IF;
 ELSIF TG_TABLE_NAME='routines' THEN
  IF OLD.plan_frozen AND NEW.state='active' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.limit'; END IF;
 ELSIF TG_TABLE_NAME='routine_revisions' THEN
  IF EXISTS(SELECT 1 FROM pactaris.routines WHERE household_id=NEW.household_id AND id=NEW.routine_id AND plan_frozen) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='plan.limit'; END IF;
 ELSIF TG_TABLE_NAME='task_series' THEN
  IF OLD.plan_frozen AND NEW.state IN ('active','blocked') AND NEW.version<>OLD.version THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='partner.capacity'; END IF;
 ELSIF TG_TABLE_NAME='task_generation_jobs' THEN
  IF NEW.state='pending' AND EXISTS(SELECT 1 FROM pactaris.task_series WHERE household_id=NEW.household_id AND id=NEW.series_id AND plan_frozen) THEN
   NEW.run_after='infinity'; END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_frozen_guard() FROM PUBLIC;
CREATE TRIGGER plan_frozen_habit BEFORE UPDATE ON pactaris.authority_habits FOR EACH ROW EXECUTE FUNCTION pactaris.plan_frozen_guard();
CREATE TRIGGER plan_frozen_routine BEFORE UPDATE OF state ON pactaris.routines FOR EACH ROW EXECUTE FUNCTION pactaris.plan_frozen_guard();
CREATE TRIGGER plan_frozen_routine_revision BEFORE INSERT ON pactaris.routine_revisions FOR EACH ROW EXECUTE FUNCTION pactaris.plan_frozen_guard();
CREATE TRIGGER plan_frozen_series BEFORE UPDATE ON pactaris.task_series FOR EACH ROW EXECUTE FUNCTION pactaris.plan_frozen_guard();
CREATE TRIGGER plan_frozen_jobs BEFORE INSERT OR UPDATE ON pactaris.task_generation_jobs FOR EACH ROW EXECUTE FUNCTION pactaris.plan_frozen_guard();

-- The Plan panel: groups that have a frozen item and that the caller may choose for.
CREATE FUNCTION pactaris.plan_frozen_list(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;groups jsonb;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('kind',g.kind,'personId',g.person,'personName',g.person_name,
   'limit',pactaris.plan_limit(target,pactaris.plan_kind_key(g.kind)),'items',g.items) ORDER BY g.kind,g.person_name),'[]'::jsonb) INTO groups
 FROM (SELECT p.kind,p.person,(SELECT o.display_name FROM pactaris.memberships o WHERE o.household_id=target AND o.id=p.person) AS person_name,
   jsonb_agg(jsonb_build_object('id',p.item,'title',left(coalesce(p.title,''),200),'frozen',p.frozen) ORDER BY p.since,p.item) AS items
  FROM pactaris.plan_freezable(target) p WHERE p.chooser=m.id
  GROUP BY p.kind,p.person HAVING bool_or(p.frozen) LIMIT 50) g;
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','listed','frozen',groups);
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_frozen_list(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- Swap: one frozen item becomes active and one active item of the same group is frozen. Only the person
-- responsible for both items may do this.
CREATE FUNCTION pactaris.plan_swap(target uuid,instance uuid,actor uuid,body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE m pactaris.memberships;a record;f record;previous text;
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed') THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(body->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO a FROM pactaris.plan_freezable(target) p WHERE p.kind=body->>'kind' AND p.item=(body->>'activateId')::uuid;
 SELECT * INTO f FROM pactaris.plan_freezable(target) p WHERE p.kind=body->>'kind' AND p.item=(body->>'freezeId')::uuid;
 IF a.item IS NULL OR f.item IS NULL OR a.chooser<>m.id OR f.chooser<>m.id THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.denied'; END IF;
 IF NOT a.frozen OR f.frozen OR a.person IS DISTINCT FROM f.person THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='workspace.conflict'; END IF;
 previous=current_setting('pactaris.plan_rebalancing',true);
 PERFORM set_config('pactaris.plan_rebalancing','on',true);
 PERFORM pactaris.plan_set_frozen(target,a.kind,f.item,true);
 PERFORM pactaris.plan_set_frozen(target,a.kind,a.item,false);
 PERFORM set_config('pactaris.plan_rebalancing',coalesce(previous,'off'),true);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'workspace.planSwap',a.item,jsonb_build_object('operationId',body->>'operationId','kind',a.kind,'frozen',f.item));
 RETURN jsonb_build_object('householdId',target,'operationId',body->>'operationId','actorMembershipId',m.id,'status','applied');
END $$;
REVOKE ALL ON FUNCTION pactaris.plan_swap(uuid,uuid,uuid,jsonb) FROM PUBLIC;

-- Apply the current limits once to every dynamic on this Instance.
DO $$DECLARE h record;BEGIN FOR h IN SELECT id FROM pactaris.households WHERE status<>'closed' LOOP PERFORM pactaris.plan_rebalance(h.id); END LOOP;END$$;
