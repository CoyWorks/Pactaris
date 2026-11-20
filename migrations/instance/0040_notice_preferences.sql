-- Per-member choice of which notice kinds to receive (docs/NOTIFICATIONS.md). A muted kind
-- creates no notice and therefore no push. Task notices keep their own preferences.
CREATE TABLE pactaris.notice_preferences (
 household_id uuid NOT NULL,member_id uuid NOT NULL,muted text[] NOT NULL DEFAULT '{}',version bigint NOT NULL DEFAULT 1,
 PRIMARY KEY(household_id,member_id),CHECK(muted <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit']::text[]),
 FOREIGN KEY(household_id,member_id) REFERENCES pactaris.memberships(household_id,id)
);
ALTER TABLE pactaris.notice_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE pactaris.notice_preferences FORCE ROW LEVEL SECURITY;
CREATE POLICY command_only ON pactaris.notice_preferences FOR ALL USING(pactaris.command_executor()) WITH CHECK(pactaris.command_executor());

CREATE OR REPLACE FUNCTION pactaris.notice(target uuid,recipient uuid,actor uuid,notice_kind text,resource uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
 INSERT INTO pactaris.member_notices(household_id,recipient_id,actor_id,kind,resource_id)
 SELECT target,recipient,actor,notice_kind,resource
 WHERE recipient IS DISTINCT FROM actor AND EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=recipient AND status='active')
  AND NOT EXISTS(SELECT 1 FROM pactaris.notice_preferences p WHERE p.household_id=target AND p.member_id=recipient AND notice_kind=ANY(p.muted))
$$;

-- Identical to 0039 apart from the preference actions.
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
   IF NOT chosen <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit']::text[] THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
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
