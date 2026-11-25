// Sets the signed-in person's name inside one dynamic (the members 'alias' action).
// Best effort: joining or creating never fails because of it, and the name can be changed later
// under Members and invitations.
export async function setMemberName(householdId:string,csrfToken:string,name:string):Promise<boolean>{
  const value=[...name.trim()].slice(0,80).join('');
  if(!value)return false;
  try{
    const r=await fetch('/api/households/'+householdId+'/members/alias',{method:'POST',signal:AbortSignal.timeout(12000),
      headers:{'Content-Type':'application/json','X-CSRF-Token':csrfToken},body:JSON.stringify({name:value,operationId:crypto.randomUUID()})});
    return r.ok;
  }catch{return false;}
}
