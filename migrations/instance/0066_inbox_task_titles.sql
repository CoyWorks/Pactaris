-- In-app notifications name the task (UI test, 25 November 2026). The inbox only holds rows for the
-- recipient's own tasks, so the title adds nothing they cannot already open. Push stays generic.
ALTER FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) RENAME TO partner_command_before_inbox_titles;
DO $$
DECLARE grantee text;
BEGIN
 FOR grantee IN SELECT rolname FROM pg_roles WHERE
  has_function_privilege(oid,'pactaris.partner_command_before_inbox_titles(uuid,uuid,uuid,uuid,text,jsonb,text)','EXECUTE')
  AND rolname<>current_user AND NOT rolsuper LOOP
  EXECUTE format('REVOKE ALL ON FUNCTION pactaris.partner_command_before_inbox_titles(uuid,uuid,uuid,uuid,text,jsonb,text) FROM %I',grantee);
 END LOOP;
END $$;

CREATE FUNCTION pactaris.partner_command(target uuid,instance uuid,actor uuid,operation uuid,action text,payload jsonb,fingerprint text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE answer jsonb;
BEGIN
 answer=pactaris.partner_command_before_inbox_titles(target,instance,actor,operation,action,payload,fingerprint);
 IF action<>'partnerInbox' OR jsonb_typeof(answer->'inbox')<>'array' THEN RETURN answer; END IF;
 RETURN jsonb_set(answer,'{inbox}',(
  SELECT coalesce(jsonb_agg(item||jsonb_build_object('title',coalesce(t.fields->>'title','')) ORDER BY n),'[]'::jsonb)
  FROM jsonb_array_elements(answer->'inbox') WITH ORDINALITY AS e(item,n)
  LEFT JOIN pactaris.partner_tasks t ON t.household_id=target AND t.id=(item->>'taskId')::uuid));
END $$;
REVOKE ALL ON FUNCTION pactaris.partner_command(uuid,uuid,uuid,uuid,text,jsonb,text) FROM PUBLIC;
