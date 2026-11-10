// Minimal CN wire implementation. No credential files, token handling, account pools,
// international endpoints, login, sign-in rewards or CLI bridge are included.
const CHAT='https://copilot.tencent.com';
const BILLING='https://www.codebuddy.cn';
async function json(url,body,signal){
 const response=await fetch(url,{method:body===undefined?'GET':'POST',redirect:'error',headers:{accept:'application/json','content-type':'application/json','user-agent':'dsh-ai-hub/0.1'},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000)});
 if(!response.ok){await response.body?.cancel();throw new Error(`AUTH_BOUNDARY: WorkBuddy CN HTTP ${response.status}; desktop API authentication is unavailable without credential access / 未接入桌面鉴权`);}
 const raw=await response.text();if(raw.length>2*1024*1024)throw new Error('CN response too large');let envelope;try{envelope=JSON.parse(raw);}catch{throw new Error('WorkBuddy CN returned non-JSON response');}
 if(envelope.code!==undefined&&![0,200].includes(envelope.code))throw new Error(`AUTH_BOUNDARY: WorkBuddy CN API code ${Number(envelope.code)}; desktop credential access was not attempted`);
 return envelope.data??envelope;
}
export async function cnModels(signal){const d=await json(CHAT+'/v3/config',undefined,signal);if(!Array.isArray(d.models))throw new Error('CN model catalog unavailable');return d.models.filter(m=>typeof m.id==='string'&&!m.tag).map(m=>({id:m.id,name:m.name??m.id,multiplier:typeof m.credits==='number'?m.credits:null}));}
export async function cnCall(prompt,model,{signal,onText}={}){const d=await json(CHAT+'/v2/chat/completions',{model,messages:[{role:'user',content:prompt}],stream:false},signal);const text=d.choices?.[0]?.message?.content;if(typeof text!=='string'||!text.trim())throw new Error('CN response contained no assistant text');onText?.(text);return {text};}
export async function cnCredits(signal){const d=await json(BILLING+'/v2/billing/meter/get-user-resource',{PageNumber:1,PageSize:100,ProductCode:'p_tcaca',Status:[0,3]},signal);return parseCnCredits(d);}

// Only documented billing fields are projected. Missing or malformed values stay unknown.
export function parseCnCredits(document,now=Date.now()){
 const accounts=document.Response?.Data?.Accounts;
 if(!Array.isArray(accounts))throw new Error('CN credit balance unavailable');
 const current=accounts.filter(row=>Number(row.CapacityType)===4||!row.ExpiredTime||Date.parse(row.ExpiredTime)>now);
 const values=current.map(row=>{
  const candidates=String(row.CapacityType)==='4'?['CycleCapacityRemainPrecise','CycleCapacityRemain','CapacityRemainPrecise','CapacityRemain']:['CapacityRemainPrecise','CapacityRemain'];
  for(const key of candidates){const raw=row[key];if(raw===undefined||raw===null||raw==='')continue;const value=Number(raw);if(Number.isFinite(value))return Math.max(0,value);}
  return null;
 });
 return {remaining:values.some(x=>x===null)?null:values.reduce((a,b)=>a+b,0),multiplier:null};
}
