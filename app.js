'use strict';
const cfg=window.TRACKER_CONFIG,status=document.getElementById('status');let jsonpBusy=false;
function jsonp(op){return new Promise((resolve,reject)=>{
 if(jsonpBusy)return reject(new Error('Request already in progress'));jsonpBusy=true;
 const tag=document.createElement('script'),timer=setTimeout(()=>finish(new Error('API timeout')),15000);
 function finish(error,data){clearTimeout(timer);tag.remove();delete window.trackerCallback;jsonpBusy=false;error?reject(error):resolve(data);}
 window.trackerCallback=data=>finish(null,data);const u=new URL(cfg.apiUrl,location.href);u.searchParams.set('op',op);u.searchParams.set('callback','trackerCallback');tag.src=u.href;tag.onerror=()=>finish(new Error('API failed'));document.head.appendChild(tag);
});}
async function submit(fields,credential,challenge){
 if(cfg.privateTransport==='fetch-experiment'){
  try{
   const response=await fetch(cfg.apiUrl,{method:'POST',headers:{'Content-Type':'text/plain;charset=utf-8'},body:JSON.stringify({...fields,credential,challenge}),redirect:'follow'});
   const result=await response.json();status.textContent=JSON.stringify(result,null,2);
  }catch(e){status.textContent='Response unavailable. A write may have committed. Do not retry blindly; inspect version with a fresh read. Reload before another request.';}
  return;
 }
 const form=document.createElement('form');form.method='POST';form.action=cfg.apiUrl;
 for(const [name,value]of Object.entries({...fields,credential,challenge})){const i=document.createElement('input');i.type='hidden';i.name=name;i.value=value;form.appendChild(i);}document.body.appendChild(form);form.submit();}
function loadGIS(){return new Promise((resolve,reject)=>{const s=document.createElement('script');s.src='https://accounts.google.com/gsi/client';s.onload=resolve;s.onerror=reject;document.head.appendChild(s);});}
if(cfg.mode==='google'){document.getElementById('mode').textContent='Google deployment experiment: synthetic data only; development-only tokeninfo verifier.';document.getElementById('identity').parentElement.hidden=true;}
if(cfg.mode==='offline'){
 document.getElementById('mode').textContent='Synthetic public preview. Google sign-in and the private backend are not connected yet.';
 const p=document.createElement('p');p.textContent='Community garden day - Saturday: bring spare gloves. (synthetic sample)';document.getElementById('public').appendChild(p);
 for(const control of document.getElementById('request').elements)control.disabled=true;
 status.textContent='Private requests are disabled until the approved Google setup is complete.';
}else{
jsonp('public').then(rows=>{for(const r of rows){const p=document.createElement('p');p.textContent=r.title+' - '+r.text+' (v'+r.version+')';document.getElementById('public').appendChild(p);}}).catch(e=>{status.textContent=e.message;});
}
document.getElementById('request').addEventListener('submit',async event=>{
 event.preventDefault();document.getElementById('prepare').disabled=true;const fields=Object.fromEntries(new FormData(event.target));if(fields.op!=='write'){delete fields.text;delete fields.version;}
 try{const {challenge}=await jsonp('challenge');
  if(cfg.mode==='mock'){const r=await fetch('/demo-token',{method:'POST',body:new URLSearchParams({sub:document.getElementById('identity').value,challenge})});const data=await r.json();submit(fields,data.credential,challenge);}
  else{await loadGIS();const nonce=JSON.parse(atob(challenge.split('.')[0].replace(/-/g,'+').replace(/_/g,'/'))).nonce;
   google.accounts.id.initialize({client_id:cfg.clientId,nonce,auto_select:false,callback:r=>submit(fields,r.credential,challenge)});
   document.getElementById('google-button').replaceChildren();google.accounts.id.renderButton(document.getElementById('google-button'),{theme:'outline',size:'large'});
   status.textContent='Sign in to submit within five minutes. Reload to change the request or after expiry.';for(const input of event.target.elements)input.disabled=true;}
 }catch(e){status.textContent=e.message;document.getElementById('prepare').disabled=false;}
});
