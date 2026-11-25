-- In-app notice payloads contain only the kind and resource identifiers.
CREATE OR REPLACE FUNCTION pactaris.notice_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE h pactaris.households;m pactaris.memberships;items jsonb;unread integer;chosen text[];people uuid[];next_id uuid;
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
   IF NOT chosen <@ ARRAY['permission','proposal','journal','breach','answered','invited','accepted','ended','delegated','points','habit','purchase','transfer','approval']::text[] THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   IF payload ? 'mutedPeople' THEN
    IF jsonb_typeof(payload->'mutedPeople') IS DISTINCT FROM 'array' OR jsonb_array_length(payload->'mutedPeople')>100 THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
    SELECT coalesce(array_agg(DISTINCT k::uuid ORDER BY k::uuid),'{}') INTO people FROM jsonb_array_elements_text(payload->'mutedPeople') k;
    IF m.id=ANY(people) OR EXISTS(SELECT 1 FROM unnest(people) p WHERE NOT EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND id=p AND status='active')) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.invalid'; END IF;
   END IF;
   INSERT INTO pactaris.notice_preferences(household_id,member_id,muted) VALUES(target,m.id,chosen)
    ON CONFLICT(household_id,member_id) DO UPDATE SET muted=EXCLUDED.muted,version=pactaris.notice_preferences.version+1;
   IF payload ? 'mutedPeople' THEN UPDATE pactaris.notice_preferences SET muted_people=people WHERE household_id=target AND member_id=m.id; END IF;
  END IF;
  RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticePreferences' THEN 'listed' ELSE 'applied' END,
   'muted',to_jsonb(coalesce((SELECT muted FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::text[])),
   'mutedPeople',to_jsonb(coalesce((SELECT muted_people FROM pactaris.notice_preferences WHERE household_id=target AND member_id=m.id),'{}'::uuid[])),
   'people',(SELECT coalesce(jsonb_agg(jsonb_build_object('id',v.id,'name',v.display_name) ORDER BY v.display_name,v.id),'[]'::jsonb) FROM
    (SELECT DISTINCT other.id,other.display_name FROM pactaris.relationship_participants own JOIN pactaris.relationship_participants rp ON rp.household_id=own.household_id AND rp.relationship_id=own.relationship_id
     JOIN pactaris.relationships rel ON rel.household_id=own.household_id AND rel.id=own.relationship_id AND rel.status='active'
     JOIN pactaris.memberships other ON other.household_id=rp.household_id AND other.id=rp.membership_id AND other.status='active'
     WHERE own.household_id=target AND own.membership_id=m.id AND own.decision='accepted' AND rp.decision='accepted' AND other.id<>m.id ORDER BY other.display_name,other.id LIMIT 100) v));
 END IF;
 IF action='noticeList' AND payload ? 'after' AND NOT EXISTS(SELECT 1 FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND id=(payload->>'after')::uuid) THEN RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='exchange.denied'; END IF;
 IF action='noticeRead' THEN
  -- Marking read is idempotent and needs no receipt.
  UPDATE pactaris.member_notices SET read=true WHERE household_id=target AND recipient_id=m.id AND NOT read
   AND (payload->'ids' IS NULL OR jsonb_typeof(payload->'ids')<>'array' OR id::text IN (SELECT jsonb_array_elements_text(payload->'ids')));
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('id',n.id,'kind',n.kind,'resourceId',n.resource_id,'actorName',NULL,'read',n.read,'createdAt',n.created_at) ORDER BY n.push_seq DESC),'[]'::jsonb) INTO items
  FROM (SELECT * FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND (NOT(payload ? 'after') OR push_seq<(SELECT push_seq FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND id=(payload->>'after')::uuid)) ORDER BY push_seq DESC LIMIT 31) n
;
 IF jsonb_array_length(items)=31 THEN next_id=(items->29->>'id')::uuid;items=items-30;END IF;
 SELECT count(*) INTO unread FROM pactaris.member_notices WHERE household_id=target AND recipient_id=m.id AND NOT read;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'actorMembershipId',m.id,'status',CASE WHEN action='noticeList' THEN 'listed' ELSE 'applied' END,
  'notices',items,'unread',unread,'nextCursor',next_id);
END $$;

