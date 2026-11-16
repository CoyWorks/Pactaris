-- Non-mutating domain receipt inspection for lost-response reconciliation.
CREATE FUNCTION pactaris.household_receipt_command(target uuid,instance uuid,actor uuid,operation uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,pactaris,pg_temp AS $$
DECLARE receipt pactaris.household_command_receipts; state text;
BEGIN
 SELECT * INTO receipt FROM pactaris.household_command_receipts WHERE operation_id=operation;
 IF NOT FOUND THEN
   RETURN jsonb_build_object('householdId',target,'operationId',operation,'status','missing');
 END IF;
 IF receipt.household_id<>target OR receipt.account_id<>actor OR
    NOT EXISTS(SELECT 1 FROM pactaris.households WHERE id=target AND instance_id=instance) THEN
   RAISE EXCEPTION USING ERRCODE='P0001',MESSAGE='command.denied';
 END IF;
 state=CASE WHEN receipt.action='leave' THEN 'left'
   WHEN EXISTS(SELECT 1 FROM pactaris.memberships WHERE household_id=target AND account_id=actor AND status='active') THEN 'created'
   ELSE 'left' END;
 RETURN jsonb_build_object('householdId',target,'operationId',operation,'status',state);
END $$;
REVOKE ALL ON FUNCTION pactaris.household_receipt_command(uuid,uuid,uuid,uuid) FROM PUBLIC;
