import { writeFile } from 'node:fs/promises';
import { join,resolve,sep } from 'node:path';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import { createHub,createAdapter,createSubagent } from './index.js';
import { PLATFORMS,ROOT,safe,failure } from './runtime.mjs';
const scratchBase=resolve(ROOT,'scratch');mkdirSync(scratchBase,{recursive:true});const runRoot=mkdtempSync(join(scratchBase,'verify-'));const hub=createHub({scratch:runRoot});
const report={at:new Date().toISOString(),scope:'Standalone bundle code with real CLIs; not installed Host/tool/UI verification',calls:[],quotas:[]};
const target=process.argv[2]??'all';
const tasks=PLATFORMS.filter(p=>target==='all'||p===target).map(async platform=>{
 for(const channel of platform==='codex'?['subagent']:['model','subagent']){
  const start=Date.now();let result,model;
  if(channel==='model'){
   const adapter=createAdapter(hub,platform);const chunks=[];
   model=(await adapter.listModels())[0]?.id;
   if(!model)throw new Error(`${platform} 未返回可供验证的模型`);
   for await(const chunk of adapter.stream({model,messages:[{role:'user',content:[{type:'text',text:'Reply with exactly OK. Do not use tools or access files.'}]}]}))chunks.push(chunk);
   const answer=chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join('');const finish=chunks.filter(c=>c.type==='finish');
   result={platform,channel,ok:answer.trim()==='OK'&&finish.length===1&&finish[0].reason.kind==='stop',answer:safe(answer),chunks:chunks.length,finish:finish[0]?.reason};
  }else if(platform!=='codex'){
   const run=await createSubagent(hub,platform).start({prompt:[{type:'text',text:'Reply with exactly OK. Do not use tools or access files.'}],cwd:runRoot});const r=await run.result;await run.dispose();
   const answer=r.output.map(b=>b.text??'').join('');result={platform,channel,ok:r.stopReason==='completed'&&answer.trim()==='OK',answer:r.stopReason==='completed'?safe(answer):'',stopReason:r.stopReason,error:r.diagnostic?safe(r.diagnostic):undefined};
  }else result=await hub.test(platform,channel,{cwd:runRoot});
  result.model=model;result.elapsedMs=Date.now()-start;report.calls.push(result);console.log(JSON.stringify(result));
 }
 const quota=await hub.quota(platform,true);report.quotas.push(quota);console.log(JSON.stringify({quota}));
});
try {await Promise.all(tasks);}catch(e){report.fatal=failure(e);}finally{hub.dispose();await writeFile(join(ROOT,'evidence','connectivity-'+target+'.json'),JSON.stringify(report,null,2));if(!resolve(runRoot).startsWith(scratchBase+sep))throw new Error('Unsafe cleanup path');rmSync(runRoot,{recursive:true,force:true});process.exitCode=report.fatal||!report.calls.length||report.calls.some(c=>!c.ok)?1:0;console.log(JSON.stringify({summary:{calls:report.calls.length,passed:report.calls.filter(c=>c.ok).length,failed:report.calls.filter(c=>!c.ok).length,exitCode:process.exitCode}}));}
