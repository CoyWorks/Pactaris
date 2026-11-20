-- Reward shop and punishment list (docs/HOUSEHOLD_AUTHORITY.md). A Dom puts their own catalog
-- rewards in the shop; subs they hold outcome authority over buy them with points. A purchase is a
-- reward redemption on the backing agreement: requested until the Dom grants or declines it, or
-- granted at once when the Dom chose so. A weekly limit counts purchases that were not declined,
-- cancelled or reversed since Monday in the household time zone. Catalog consequences are the
-- Dom's punishment list; giving one still goes through punishmentGive.
CREATE TABLE pactaris.shop_listings (
 household_id uuid NOT NULL,item_id uuid NOT NULL,holder_id uuid NOT NULL,
 auto_grant boolean NOT NULL DEFAULT false,weekly_limit integer CHECK(weekly_limit BETWEEN 1 AND 100),
 version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(household_id,item_id),
 FOREIGN KEY(household_id,item_id) REFERENCES pactaris.catalog_items(household_id,id),
 FOREIGN KEY(household_id,holder_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.shop_listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.shop_listings FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.shop_listings FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());
ALTER TABLE pactaris.reward_redemptions ADD COLUMN created_at timestamptz NOT NULL DEFAULT statement_timestamp();
CREATE INDEX reward_redemptions_item ON pactaris.reward_redemptions(household_id,item_id,recipient_id,created_at);

ALTER TABLE pactaris.member_notices DROP CONSTRAINT member_notices_kind_check,
 ADD CONSTRAINT member_notices_kind_check CHECK(kind IN ('permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase'));
ALTER TABLE pactaris.notice_preferences DROP CONSTRAINT notice_preferences_muted_check,
 ADD CONSTRAINT notice_preferences_muted_check CHECK(muted <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase']::text[]);

CREATE FUNCTION pactaris.shop_week_start(target uuid) RETURNS timestamptz
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 SELECT date_trunc('week',statement_timestamp() AT TIME ZONE h.time_zone) AT TIME ZONE h.time_zone FROM pactaris.households h WHERE h.id=target
$$;
REVOKE ALL ON FUNCTION pactaris.shop_week_start(uuid) FROM PUBLIC;

CREATE FUNCTION pactaris.shop_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;prior pactaris.authority_receipts;i pactaris.catalog_items;l pactaris.shop_listings;
 ap pactaris.authority_pairs;a pactaris.agreements;f jsonb;item_fields jsonb;answer jsonb;resource uuid;cost integer;used integer;week timestamptz;
 offers jsonb;mine jsonb;requests jsonb;history jsonb;spend boolean;
BEGIN
 IF action IS NULL OR action NOT IN ('shopList','shopSave','shopArchive','shopBuy') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.invalid';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.authority.operation.'||operation::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended('pactaris.household.'||target::text,0));
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
 week=pactaris.shop_week_start(target);
 IF action='shopList' THEN
  -- What I can buy: listed, current rewards of every Dom with outcome authority over me.
  SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',x.id,'version',x.version::text,'holderId',x.holder_id,'holderName',x.holder_name,
    'title',x.fields->>'title','description',x.fields->>'description','points',(x.fields->>'points')::integer,'autoGrant',x.auto_grant,'weeklyLimit',x.weekly_limit,
    'usedThisWeek',(SELECT count(*) FROM pactaris.reward_redemptions r WHERE r.household_id=target AND r.item_id=x.id AND r.recipient_id=m.id
      AND r.created_at>=week AND r.state IN ('requested','fulfilled') AND (r.state='fulfilled' OR r.expires_at>now())))
    ORDER BY (x.fields->>'points')::integer,x.fields->>'title',x.id),'[]'::jsonb) INTO offers
   FROM (SELECT c.id,c.version,s.holder_id,s.auto_grant,s.weekly_limit,v.fields,hm.display_name AS holder_name
    FROM pactaris.shop_listings s JOIN pactaris.catalog_items c ON c.household_id=s.household_id AND c.id=s.item_id AND c.state='draft'
    JOIN pactaris.catalog_versions v ON v.household_id=c.household_id AND v.item_id=c.id AND v.version=c.version
    JOIN pactaris.memberships hm ON hm.household_id=s.household_id AND hm.id=s.holder_id AND hm.status='active'
    WHERE s.household_id=target AND s.holder_id<>m.id AND coalesce(v.fields->>'kind','reward')='reward' AND v.fields->>'points' IS NOT NULL
     AND pactaris.authority_area(target,s.holder_id,m.id,'outcomes') ORDER BY c.id LIMIT 100) x;
  spend=NOT EXISTS(SELECT 1 FROM pactaris.authority_links WHERE household_id=target AND state='active' AND sub_id=m.id AND NOT can_spend_points);
  -- My own rewards and punishments, listed or not.
  SELECT coalesce(jsonb_agg(jsonb_build_object('itemId',c.id,'version',c.version::text,'kind',coalesce(v.fields->>'kind','reward'),
    'title',v.fields->>'title','description',v.fields->>'description','points',(v.fields->>'points')::integer,
    'listed',s.item_id IS NOT NULL,'autoGrant',coalesce(s.auto_grant,false),'weeklyLimit',s.weekly_limit) ORDER BY v.fields->>'title',c.id),'[]'::jsonb) INTO mine
   FROM (SELECT * FROM pactaris.catalog_items WHERE household_id=target AND creator_membership_id=m.id AND state='draft' ORDER BY id LIMIT 100) c
   JOIN pactaris.catalog_versions v ON v.household_id=c.household_id AND v.item_id=c.id AND v.version=c.version
   LEFT JOIN pactaris.shop_listings s ON s.household_id=c.household_id AND s.item_id=c.id
   WHERE coalesce(v.fields->>'kind','reward') IN ('reward','consequence');
  -- Purchases waiting for me to grant or decline.
  SELECT coalesce(jsonb_agg(jsonb_build_object('redemptionId',r.id,'version',r.version::text,'buyerId',r.recipient_id,'buyerName',b.display_name,
    'title',r.terms->>'title','points',r.points,'createdAt',r.created_at) ORDER BY r.created_at),'[]'::jsonb) INTO requests
   FROM (SELECT * FROM pactaris.reward_redemptions WHERE household_id=target AND issuer_id=m.id AND state='requested' AND expires_at>now()
    AND terms->>'source'='shop' ORDER BY created_at LIMIT 50) r JOIN pactaris.memberships b ON b.household_id=r.household_id AND b.id=r.recipient_id;
  -- My own recent purchases.
  SELECT coalesce(jsonb_agg(jsonb_build_object('redemptionId',r.id,'version',r.version::text,'title',r.terms->>'title','points',r.points,
    'state',CASE WHEN r.state='requested' AND r.expires_at<=now() THEN 'expired' ELSE r.state END,'createdAt',r.created_at) ORDER BY r.created_at DESC),'[]'::jsonb) INTO history
   FROM (SELECT * FROM pactaris.reward_redemptions WHERE household_id=target AND recipient_id=m.id AND terms->>'source'='shop' ORDER BY created_at DESC LIMIT 10) r;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','listed',
   'balance',pactaris.authority_points(target,m.id)::text,'canSpend',spend,'pointsEnabled',h.points_enabled,
   'offers',offers,'items',mine,'requests',requests,'purchases',history);
 END IF;
 SELECT * INTO prior FROM pactaris.authority_receipts WHERE operation_id=operation;
 IF FOUND THEN
  IF prior.household_id<>target OR prior.actor_membership_id<>m.id OR prior.request_hash<>fingerprint THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  RETURN prior.result;
 END IF;
 IF action='shopSave' THEN
  f=payload->'fields';
  IF f->>'kind'='reward' AND (f->>'points')::integer>0 AND NOT h.points_enabled THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  item_fields=jsonb_build_object('title',f->>'title','description',f->>'description','category','','points',(f->'points'),'position',0,'kind',f->>'kind');
  IF payload->>'itemId' IS NULL THEN
   IF (SELECT count(*) FROM pactaris.catalog_items WHERE household_id=target AND creator_membership_id=m.id AND state='draft')>=100 THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
   INSERT INTO pactaris.catalog_items(household_id,id,creator_membership_id) VALUES(target,operation,m.id);
   INSERT INTO pactaris.catalog_versions(household_id,item_id,version,fields) VALUES(target,operation,1,item_fields);
   resource=operation;
  ELSE
   SELECT * INTO i FROM pactaris.catalog_items WHERE household_id=target AND id=(payload->>'itemId')::uuid AND creator_membership_id=m.id FOR UPDATE;
   IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
   IF i.state<>'draft' OR i.version::text IS DISTINCT FROM payload->>'version'
    OR coalesce((SELECT fields->>'kind' FROM pactaris.catalog_versions WHERE household_id=target AND item_id=i.id AND version=i.version),'reward')<>f->>'kind' THEN
    RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
   IF (SELECT fields FROM pactaris.catalog_versions WHERE household_id=target AND item_id=i.id AND version=i.version) IS DISTINCT FROM item_fields THEN
    UPDATE pactaris.catalog_items SET version=version+1 WHERE household_id=target AND id=i.id;
    INSERT INTO pactaris.catalog_versions(household_id,item_id,version,fields) VALUES(target,i.id,i.version+1,item_fields);
   END IF;
   resource=i.id;
  END IF;
  IF f->>'kind'='reward' AND (payload->>'listed')::boolean THEN
   INSERT INTO pactaris.shop_listings(household_id,item_id,holder_id,auto_grant,weekly_limit)
    VALUES(target,resource,m.id,(payload->>'autoGrant')::boolean,(payload->>'weeklyLimit')::integer)
    ON CONFLICT(household_id,item_id) DO UPDATE SET auto_grant=EXCLUDED.auto_grant,weekly_limit=EXCLUDED.weekly_limit,version=pactaris.shop_listings.version+1;
  ELSE
   DELETE FROM pactaris.shop_listings WHERE household_id=target AND item_id=resource;
  END IF;
 ELSIF action='shopArchive' THEN
  SELECT * INTO i FROM pactaris.catalog_items WHERE household_id=target AND id=(payload->>'itemId')::uuid AND creator_membership_id=m.id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF i.state<>'draft' OR i.version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  UPDATE pactaris.catalog_items SET state='archived',version=version+1 WHERE household_id=target AND id=i.id;
  INSERT INTO pactaris.catalog_versions(household_id,item_id,version,fields)
   SELECT target,i.id,i.version+1,fields FROM pactaris.catalog_versions WHERE household_id=target AND item_id=i.id AND version=i.version;
  DELETE FROM pactaris.shop_listings WHERE household_id=target AND item_id=i.id;
  resource=i.id;
 ELSE
  -- shopBuy: the price is the item version the buyer saw.
  SELECT * INTO l FROM pactaris.shop_listings WHERE household_id=target AND item_id=(payload->>'itemId')::uuid;
  SELECT * INTO i FROM pactaris.catalog_items WHERE household_id=target AND id=l.item_id AND state='draft';
  IF l.item_id IS NULL OR i.id IS NULL OR l.holder_id=m.id OR NOT pactaris.authority_area(target,l.holder_id,m.id,'outcomes') THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.denied'; END IF;
  IF i.version::text IS DISTINCT FROM payload->>'version' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  SELECT fields INTO item_fields FROM pactaris.catalog_versions WHERE household_id=target AND item_id=i.id AND version=i.version;
  cost=(item_fields->>'points')::integer;
  IF coalesce(item_fields->>'kind','reward')<>'reward' OR cost IS NULL OR (cost>0 AND NOT h.points_enabled) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  SELECT * INTO ap FROM pactaris.authority_pairs WHERE household_id=target AND holder_id=l.holder_id AND subject_id=m.id;
  SELECT * INTO a FROM pactaris.agreements WHERE household_id=target AND id=ap.agreement_id;
  -- Pauses, stops, blocked rewards and a Dom who switched off spending all block a purchase.
  IF ap.agreement_id IS NULL OR NOT pactaris.activity_guard(target,instance,actor,m.id,a.id,a.version,'reward',h.safety_version) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.paused'; END IF;
  IF l.weekly_limit IS NOT NULL THEN
   SELECT count(*) INTO used FROM pactaris.reward_redemptions r WHERE r.household_id=target AND r.item_id=i.id AND r.recipient_id=m.id
    AND r.created_at>=week AND r.state IN ('requested','fulfilled') AND (r.state='fulfilled' OR r.expires_at>now());
   IF used>=l.weekly_limit THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.capacity'; END IF;
  END IF;
  IF cost>0 AND pactaris.available_reward_points(target,instance,actor,m.id)<cost THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='authority.conflict'; END IF;
  INSERT INTO pactaris.reward_redemptions(household_id,id,issuer_id,recipient_id,agreement_id,agreement_version,household_epoch,item_id,item_version,terms,points,state,expires_at)
   VALUES(target,operation,l.holder_id,m.id,a.id,a.version,h.safety_version,i.id,i.version,item_fields||jsonb_build_object('source','shop'),cost,
    CASE WHEN l.auto_grant THEN 'fulfilled' ELSE 'requested' END,statement_timestamp()+interval '14 days');
  IF l.auto_grant AND cost>0 THEN
   INSERT INTO pactaris.reward_point_entries(household_id,redemption_id,kind,operation_id) VALUES(target,operation,'debit',operation);
  END IF;
  PERFORM pactaris.notice(target,l.holder_id,m.id,'purchase',operation);
  resource=operation;
 END IF;
 answer=jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status','applied','resourceId',resource);
 INSERT INTO pactaris.authority_receipts VALUES(operation,target,m.id,fingerprint,answer);
 INSERT INTO pactaris.audit_events(household_id,id,actor_account_id,event_key,resource_id,parameters)
  VALUES(target,gen_random_uuid(),actor,'authority.'||action,resource,jsonb_build_object('operationId',operation));
 RETURN answer;
END $$;
REVOKE ALL ON FUNCTION pactaris.shop_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;

-- Identical to 0040 apart from the purchase notice kind.
CREATE OR REPLACE FUNCTION pactaris.notice_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;items jsonb;unread integer;chosen text[];
BEGIN
 IF action IS NULL OR action NOT IN ('noticeList','noticeRead','noticePreferences','noticeConfigure') OR fingerprint IS NULL OR fingerprint!~'^[a-f0-9]{64}$' THEN
  RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid';
 END IF;
 SELECT * INTO h FROM pactaris.households WHERE id=target AND instance_id=instance AND status<>'closed';
 SELECT * INTO m FROM pactaris.memberships WHERE household_id=target AND id=(payload->>'membershipId')::uuid AND account_id=actor AND status='active';
 IF h.id IS NULL OR m.id IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action IN ('noticePreferences','noticeConfigure') THEN
  IF action='noticeConfigure' THEN
   IF jsonb_typeof(payload->'muted')<>'array' THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   SELECT coalesce(array_agg(DISTINCT k ORDER BY k),'{}') INTO chosen FROM jsonb_array_elements_text(payload->'muted') k;
   IF NOT chosen <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase']::text[] THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   INSERT INTO pactaris.notice_preferences(household_id,member_id,muted) VALUES(target,m.id,chosen)
    ON CONFLICT(household_id,member_id) DO UPDATE SET muted=EXCLUDED.muted,version=pactaris.notice_preferences.version+1;
  END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticePreferences' THEN 'listed' ELSE 'applied' END,
   'muted',to_jsonb(coalesce((SELECT muted FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::text[])));
 END IF;
 IF action='noticeRead' THEN
  -- Marking read is idempotent and needs no receipt.
  UPDATE pactaris.member_notices SET read=true WHERE household_id=target AND recipient_id=m.id AND NOT read
   AND (payload->'ids' IS NULL OR jsonb_typeof(payload->'ids')<>'array' OR id::text IN (SELECT jsonb_array_elements_text(payload->'ids')));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'resourceId',n.resource_id,'actorName',a.display_name,'read',n.read,'createdAt',n.created_at) ORDER BY n.push_seq DESC),'[]'::jsonb) INTO items
  FROM (SELECT * FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id ORDER BY push_seq DESC LIMIT 30) n
  LEFT JOIN pactaris.memberships a ON a.household_id=n.household_id AND a.id=n.actor_id;
 SELECT count(*) INTO unread FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND NOT read;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticeList' THEN 'listed' ELSE 'applied' END,
  'notices',items,'unread',unread);
END $$;
