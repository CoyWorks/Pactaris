const channelName='pactaris-session';
const signOutMessage='signed-out';

export function announceSignOut(){
  if(typeof BroadcastChannel==='undefined')return;
  try{
    const channel=new BroadcastChannel(channelName);
    try{channel.postMessage(signOutMessage);}
    finally{channel.close();}
  }catch{
    // The server session is already revoked. Other tabs also revalidate on resume.
  }
}

export function listenForSignOut(invalidate:()=>void){
  if(typeof BroadcastChannel==='undefined')return;
  try{
    const channel=new BroadcastChannel(channelName);
    channel.onmessage=event=>{if(event.data===signOutMessage)invalidate();};
    return ()=>channel.close();
  }catch{
    // Some browsing contexts do not support inter-tab messaging.
  }
}
