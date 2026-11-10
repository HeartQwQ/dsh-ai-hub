import test from 'node:test';
import assert from 'node:assert/strict';
import {createHub, normalizeSettings} from './index.js';
import {command, cursorQuota, cursorAccount, codexAccount, codexQuota, decodeJwtPayload, publicAccountIdentity, failure} from './runtime.mjs';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createWorkbuddy, deriveAtRestKey, sealEncryptedField, openEncryptedField} from './workbuddy.mjs';

function makeJwt(payload) {
 const header = Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
 return `${header}.${body}.sig`;
}
const report = 'Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-16T03:46:47Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t64%\t2026-11-14T10:14:22Z\n';
const cliDetect = () => ({command:'agy.exe',prefix:[]});
test('WorkBuddy only claims an active unclaimed day and coalesces concurrent claims', async () => {
 const requests = [];
 let claimed = false;
 const workbuddy = createWorkbuddy({
  credentials:{
   readRecord:async () => ({kind:'grant',payload:{uid:'fixture',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAtMs:Date.now()+3_600_000}}),
   modifyRecord:async () => {}
  },
  fetchCheckin:async (url, options) => {
   assert.equal(options.redirect,'error');
   const action = new URL(url).pathname.split('/').at(-1);
   requests.push(action);
   if (action === 'daily-checkin') {
    claimed = true;
    return Response.json({code:0,data:{credit:100,streak_days:8}});
   }
   return Response.json({code:0,data:{active:true,today_checked_in:claimed,streak_days:claimed?8:7}});
  }
 });
 assert.equal((await workbuddy.checkinStatus()).claimed,false);
 assert.deepEqual(requests,['checkin-activity-status']);
 const results = await Promise.all([workbuddy.claimCheckin(),workbuddy.claimCheckin()]);
 assert.deepEqual(results,[{active:true,claimed:true,credit:100,streakDays:8},{active:true,claimed:true,credit:100,streakDays:8}]);
 assert.equal((await workbuddy.claimCheckin()).claimed,true);
 assert.equal(requests.filter(action=>action==='daily-checkin').length,1);
});
test('WorkBuddy preserves monthly credits and falls back to the cycle end for undated packages', async () => {
 const pages = [];
 const nextMonth = new Date(Date.now()+30*86_400_000).toISOString();
 const expired = new Date(Date.now()-86_400_000).toISOString();
 const rows = [
  [{CapacityType:4,CycleCapacitySizePrecise:'500',CycleCapacityRemainPrecise:'400.25',CycleEndTime:nextMonth}],
  [{CapacityType:1,PackageName:'活动积分',CapacityRemain:'100',ExpiredTime:'',CycleEndTime:nextMonth},
   {CapacityType:1,PackageName:'已过期',CapacityRemain:'100',ExpiredTime:'',CycleEndTime:expired}]
 ];
 const workbuddy = createWorkbuddy({
  credentials:{
   readRecord:async () => ({kind:'grant',payload:{uid:'fixture',accessToken:'fixture-access',refreshToken:'fixture-refresh',expiresAtMs:Date.now()+3_600_000}}),
   modifyRecord:async () => {}
  },
  fetchBilling:async (_url, options) => {
   const page = JSON.parse(options.body).PageNumber;
   pages.push(page);
   return Response.json({code:0,data:{Response:{Data:{TotalCount:3,Accounts:rows[page-1]}}}});
  }
 });
 const result = await workbuddy.credits();
 assert.deepEqual(pages,[1,2]);
 assert.equal(result.remaining,500.25);
 assert.deepEqual(result.packages,[
  {monthly:true,name:'',remaining:400.25,total:500,endsAt:Date.parse(nextMonth)},
  {monthly:false,name:'活动积分',remaining:100,total:null,endsAt:Date.parse(nextMonth)}
 ]);
});
test('Codex 模型页优先使用内置目录，空目录回退到本机 Codex，刷新时重新检查内置目录', async () => {
 let upstream = [];
 let fallbackCalls = 0;
 const hub = createHub({
  loadModels: async () => upstream,
  loadCodexModels: async () => { fallbackCalls++; return [{id:'local-model'}]; }
 });
 try {
  const result = await hub.catalogInfo('codex', true);
  assert.deepEqual(result.models.map(model => model.id), ['local-model']);
  assert.equal(result.error, null);
  upstream = [{id:'native-model'}];
  assert.deepEqual((await hub.catalogInfo('codex', true)).models.map(model => model.id), ['native-model']);
  assert.equal(fallbackCalls, 1);
 } finally {hub.dispose();}
});
test('平台身份仅返回展示字段，并掩码邮箱、手机号和账号 ID', () => {
 assert.deepEqual(publicAccountIdentity({
  name: 'Test User', contact: 'person@example.com', avatarUrl: 'https://images.example.com/avatar.png', token: 'secret'
 }), { name:'Test User', account:'p***@example.com', avatarUrl:'https://images.example.com/avatar.png' });
 assert.deepEqual(publicAccountIdentity({
  name:'18712345678', contact:'18712345678', avatarUrl:'https://example.com/pic?token=secret'
 }), { name:'', account:'187******678', avatarUrl:'' });
 assert.equal(publicAccountIdentity({contact:'187******88'}).account,'187******88');
 assert.equal(publicAccountIdentity({contact:'123'}).account,'***');
});
test('旧默认模型不生效，无指定模型的 CLI 调用沿用平台选择', async () => {
 const legacy = {cursor:{model:'old-default',visibleModels:['visible']}};
 assert.equal(normalizeSettings(legacy).cursor.model,undefined);
 assert.deepEqual(normalizeSettings(legacy).cursor.visibleModels,['visible']);
 let passedModel;
 const hub = createHub({config:{platforms:legacy},cliCaller:async (_platform,_prompt,model)=>{
  passedModel = model;
  return {text:'OK'};
 }});
 try {
  await hub.call('cursor','test',{channel:'subagent'});
  assert.equal(passedModel,undefined);
  for (const platform of ['cursor','antigravity','codex','workbuddy-cn']) {
   const spec = command(platform,'test',undefined,'model',undefined,{command:'fixture.exe',prefix:[]});
   assert(!spec.args.includes('--model')&&!spec.args.includes('-m'));
  }
 } finally {hub.dispose();}
});
test('Cursor uses both pool fields from its first-party service and ignores the combined percentage', async t => {
 const appData = await mkdtemp(join(tmpdir(), 'dsh-cursor-quota-'));
 t.after(() => rm(appData, {recursive:true, force:true}));
 await mkdir(join(appData, 'Cursor'));
 await writeFile(join(appData, 'Cursor', 'auth.json'), JSON.stringify({accessToken:'fixture.cursor.token'}));
 const windows = await cursorQuota(undefined, {appData, fetchUsage:async (url, options) => {
  assert.equal(url,'https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage');
  assert.equal(options.redirect,'error');
  assert.equal(options.headers.authorization,'Bearer fixture.cursor.token');
  return Response.json({billingCycleEnd:'1796317670000',planUsage:{autoPercentUsed:0.115555,apiPercentUsed:56.444444,totalPercentUsed:5.2}});
 }});
 assert.deepEqual(windows.map(({id,remainingPercent})=>[id,remainingPercent]),[['cursor-models',99.88],['other-models',43.56]]);
 assert.equal(windows[0].resetAt,new Date(1796317670000).toISOString());
 await assert.rejects(cursorQuota(undefined,{appData,fetchUsage:async()=>new Response(null,{status:401})}),/AUTH_BOUNDARY/);
});
test('Antigravity 模型目录可读而额度未知，不应被当成未登录',async()=>{
 const hub=createHub({cliDetect,loadModels:async()=>[{id:'gemini-test',name:'Gemini Test'}],processRunner:async()=>({code:0,stdout:'No quota report',stderr:''})});
 const quota=await hub.quota('antigravity',true);
 assert.equal(quota.kind,'unknown');assert.equal(quota.modelCount,1);assert.notEqual(quota.error.code,'AUTH');assert.equal(quota.source,'antigravity-cli');hub.dispose();
});
test('Antigravity CLI 的 Please sign in 保留 AUTH 分类',async()=>{
 const hub=createHub({cliDetect:()=>({command:'agy.exe',prefix:[]}),processRunner:async()=>({code:1,stdout:'',stderr:'Error: Please sign in to view available models. Launch the CLI without arguments to sign in.'})});
 const quota=await hub.quota('antigravity',true);
 assert.equal(quota.error.code,'AUTH');hub.dispose();
});
test('旧模型或旧连接状态不能覆盖最新鉴权失败',async()=>{
 let expired=false;
 const hub=createHub({cliDetect,processRunner:async()=>expired?{code:1,stdout:'',stderr:'Please sign in'}:{code:0,stdout:report,stderr:''}});
 await hub.quota('antigravity',true);expired=true;
 const quota=await hub.quota('antigravity',true);assert.equal(quota.error.code,'AUTH');assert.equal(quota.stale,true);hub.dispose();
});
test('成功返回目录时，不把初始化期间的未登录日志当成鉴权失败',async()=>{
 const hub=createHub({cliDetect,processRunner:async({args})=>({code:0,stdout:args.includes('models')?'gemini-test - Gemini Test\n':report,stderr:'quota refresh skipped (not logged in) during initialization'})});
 const quota=await hub.quota('antigravity',true);assert.equal(quota.error,undefined);assert.equal(quota.kind,'window');hub.dispose();
});
test('额度保留真实剩余比例和重置时间，缓存到期合并刷新，失败保留成功值并退避',async t=>{
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-10T12:00:00Z')});
 let reads=0;
 let fail=false;
 const hub=createHub({cliDetect,loadModels:async()=>[{id:'gemini-test'}],processRunner:async({args})=>{
  assert.deepEqual(args,['--print','/usage','--output-format','text']);
  reads++;
  return {code:fail?1:0,stdout:fail?'':report,stderr:''};
 }});
 t.after(()=>hub.dispose());
 const quota=await hub.quota('antigravity');
 assert.equal(quota.windows[1].remainingPercent,64);
 assert.equal(quota.windows[1].resetAt,'2026-11-14T10:14:22.000Z');
 assert.deepEqual(await hub.quota('antigravity'),quota);
 assert.equal(reads,1);
 t.mock.timers.tick(300_000);
 fail=true;
 const [failed,joined]=await Promise.all([hub.quota('antigravity'),hub.quota('antigravity',true)]);
 assert.deepEqual(failed,joined);
 assert.equal(reads,2);
 assert.deepEqual(failed.windows,quota.windows);
 assert.equal(failed.updatedAt,quota.updatedAt);
 assert.equal(failed.stale,true);
 await hub.quota('antigravity');
 assert.equal(reads,2);
 t.mock.timers.tick(60_000);
 fail=false;
 assert.equal((await hub.quota('antigravity')).stale,false);
 assert.equal(reads,3);
});

test('WorkBuddy decrypts 5.6.0+ $wbEncrypted desktop fields, prioritizes live files over backups, and reports clear AUTH_BOUNDARY when key is missing', async t => {
 const dir = await mkdtemp(join(tmpdir(), 'dsh-wb-desktop-'));
 t.after(() => rm(dir, {recursive:true, force:true}));
 const key = deriveAtRestKey('fixture-at-rest-secret');
 assert.ok(key?.keyId);
 const sample = sealEncryptedField('hello-wb', key);
 assert.equal(openEncryptedField(sample, key), 'hello-wb');
 assert.equal(openEncryptedField(sample, deriveAtRestKey('wrong-secret')), undefined);

 // Backup file has a far-future expiresAt (simulating revoked backup), while live file has the active encrypted credential.
 await writeFile(join(dir, 'workbuddy-backup-2099.info'), JSON.stringify({
  auth:{accessToken:'revoked-backup-token',refreshToken:'revoked-refresh',expiresAt:Math.floor((Date.now()+86_400_000*365)/1000)},
  account:{uid:'backup-uid',nickname:'BackupUser'}
 }));
 await writeFile(join(dir, 'workbuddy-desktop-ai.info'), JSON.stringify({
  auth:{
   accessToken:sealEncryptedField('live-decrypted-access', key),
   refreshToken:sealEncryptedField('live-decrypted-refresh', key),
   expiresAt:Math.floor((Date.now()+3_600_000)/1000),
   lastRefreshTime:Date.now()
  },
  account:{
   uid:sealEncryptedField('live-uid-123456', key),
   nickname:sealEncryptedField('LiveBuddy', key),
   uin:sealEncryptedField('100001234', key)
  }
 }));

 let stored = null;
 const wb = createWorkbuddy({
  credentials:{readRecord:async()=>stored,modifyRecord:async(_k,fn)=>{stored=fn(stored);}},
  desktopAuthDirs:[dir],
  vaultDir:join(dir,'empty-vault'),
  legacyAuthFile:join(dir,'none.json'),
  atRestKey:key,
  fetchCheckin:async(_url,options)=>{
   assert.equal(options.headers.Authorization,'Bearer live-decrypted-access');
   return Response.json({code:0,data:{active:true,today_checked_in:true,streak_days:3}});
  }
 });
 const checkin = await wb.checkinStatus();
 assert.deepEqual(checkin, {active:true,claimed:true,streakDays:3});
 assert.equal(stored.payload.nickname, 'LiveBuddy');
 assert.equal(stored.payload.uid, 'live-uid-123456');

 // When only encrypted desktop credentials exist and no key is available, surface a clear AUTH_BOUNDARY error.
 await rm(join(dir, 'workbuddy-backup-2099.info'));
 const wbNoKey = createWorkbuddy({
  credentials:{readRecord:async()=>null,modifyRecord:async()=>{}},
  desktopAuthDirs:[dir],
  vaultDir:join(dir,'empty-vault'),
  legacyAuthFile:join(dir,'none.json'),
  atRestKey:null
 });
 await assert.rejects(wbNoKey.credits(), /AUTH_BOUNDARY.*已加密/);
 const snap = await wbNoKey.snapshot();
 assert.equal(snap.loggedIn, false);
 assert.match(snap.error, /AUTH_BOUNDARY.*已加密/);
});

test('WorkBuddy coalesces concurrent token refreshes, omits stale Authorization header on refresh, preserves nickname, and falls back to valid token when refresh fails', async () => {
 let refreshCalls = 0;
 let saved = {
  kind:'grant',
  payload:{
   uid:'u-100',
   nickname:'KeepMyName',
   uin:'123456789',
   accessToken:'expiring-soon-token',
   refreshToken:'r-token-1',
   // Within 5-minute refresh margin (2 minutes left), but still > 30s valid
   expiresAtMs:Date.now()+120_000
  }
 };
 let failRefresh = false;
 const wb = createWorkbuddy({
  credentials:{
   readRecord:async()=>saved,
   modifyRecord:async(_k,fn)=>{saved=fn(saved);}
  },
  fetchRefresh:async(_url,options)=>{
   refreshCalls++;
   assert.equal(options.headers.Authorization, undefined);
   assert.equal(options.headers['X-Refresh-Token'], 'r-token-1');
   assert.equal(options.headers['X-Auth-Refresh-Source'], 'workbuddy');
   if (failRefresh) return new Response('gateway timeout', {status:502});
   return Response.json({
    code:0,
    data:{
     accessToken:'fresh-token-2',
     refreshToken:'r-token-2',
     expiresIn:7200
    }
   });
  },
  fetchCheckin:async(_url,options)=>Response.json({
   code:0,
   data:{active:true,today_checked_in:options.headers.Authorization==='Bearer fresh-token-2',streak_days:5}
  })
 });
 const [a, b] = await Promise.all([wb.checkinStatus(), wb.checkinStatus()]);
 assert.equal(refreshCalls, 1);
 assert.equal(a.claimed, true);
 assert.equal(b.claimed, true);
 assert.equal(saved.payload.nickname, 'KeepMyName');
 assert.equal(saved.payload.accessToken, 'fresh-token-2');

 // Now test fallback when refresh fails with 502 while token still has > 30s validity
 failRefresh = true;
 saved = {
  kind:'grant',
  payload:{
   uid:'u-100',
   nickname:'KeepMyName',
   accessToken:'still-valid-token',
   refreshToken:'r-token-1',
   expiresAtMs:Date.now()+90_000
  }
 };
 const wbFallback = createWorkbuddy({
  credentials:{readRecord:async()=>saved,modifyRecord:async(_k,fn)=>{saved=fn(saved);}},
  fetchRefresh:async()=>new Response('bad gateway',{status:502}),
  fetchCheckin:async(_url,options)=>{
   assert.equal(options.headers.Authorization,'Bearer still-valid-token');
   return Response.json({code:0,data:{active:true,today_checked_in:false}});
  }
 });
 const fallbackStatus = await wbFallback.checkinStatus();
 assert.equal(fallbackStatus.active, true);
});

test('Codex reads local auth.json JWT and wham/usage directly, and falls back to codexRpc when expired or failing', async t => {
 const codexHome = await mkdtemp(join(tmpdir(), 'dsh-codex-home-'));
 t.after(() => rm(codexHome, {recursive:true, force:true}));
 const futureExp = Math.floor((Date.now()+3_600_000)/1000);
 const accessToken = makeJwt({
  exp:futureExp,
  'https://api.openai.com/profile':{email:'codex.user@example.com',name:'Codex User'},
  'https://api.openai.com/auth':{chatgpt_account_id:'acct_test_123',chatgpt_plan_type:'plus'}
 });
 await writeFile(join(codexHome, 'auth.json'), JSON.stringify({
  tokens:{access_token:accessToken,refresh_token:'rt_1',account_id:'acct_test_123'}
 }));
 let rpcCalls = 0;
 const acc = await codexAccount(undefined, {codexHome, rpc:async()=>{rpcCalls++;return {};}});
 assert.equal(rpcCalls, 0);
 assert.equal(acc.account.email, 'codex.user@example.com');
 assert.equal(acc.account.planType, 'plus');

 const usage = await codexQuota(undefined, undefined, {
  codexHome,
  fetchUsage:async(url, options)=>{
   assert.equal(url, 'https://chatgpt.com/backend-api/wham/usage');
   assert.equal(options.headers['chatgpt-account-id'], 'acct_test_123');
   assert.equal(options.headers.authorization, `Bearer ${accessToken}`);
   return Response.json({
    plan_type:'plus',
    rate_limit:{
     primary_window:{used_percent:22.5,limit_window_seconds:18000,reset_at:1796000000},
     secondary_window:{used_percent:45,limit_window_seconds:604800,reset_at:1796500000}
    },
    rate_limit_reset_credits:{available_count:2}
   });
  },
  rpc:async()=>{rpcCalls++;return {};}
 });
 assert.equal(rpcCalls, 0);
 assert.equal(usage.source, 'codex-wham-usage');
 assert.equal(usage.rateLimits.planType, 'plus');
 assert.equal(usage.rateLimits.primary.windowDurationMins, 300);
 assert.equal(usage.rateLimits.secondary.windowDurationMins, 10080);
 assert.equal(usage.rateLimitResetCredits.availableCount, 2);

 // Fallback to codexRpc when wham/usage fails
 const fallbackUsage = await codexQuota(undefined, undefined, {
  codexHome,
  fetchUsage:async()=>new Response('error',{status:500}),
  rpc:async(method)=>{
   rpcCalls++;
   assert.equal(method, 'account/rateLimits/read');
   return {rateLimits:{planType:'pro',primary:{usedPercent:10,windowDurationMins:300,resetsAt:1796000000}}};
  }
 });
 assert.equal(rpcCalls, 1);
 assert.equal(fallbackUsage.rateLimits.planType, 'pro');
});

test('Cursor pre-checks expired JWT with CLI refresh retry, classifies 429 Retry-After as RATE_LIMIT, and falls back for account info', async t => {
 const appData = await mkdtemp(join(tmpdir(), 'dsh-cursor-opt-'));
 t.after(() => rm(appData, {recursive:true, force:true}));
 await mkdir(join(appData, 'Cursor'));
 const expiredToken = makeJwt({sub:'u1',exp:Math.floor((Date.now()-60_000)/1000)});
 const freshToken = makeJwt({sub:'u1',exp:Math.floor((Date.now()+3_600_000)/1000),email:'jwt.cursor@example.com',name:'Cursor JWT'});
 await writeFile(join(appData, 'Cursor', 'auth.json'), JSON.stringify({accessToken:expiredToken}));
 assert.equal(decodeJwtPayload(freshToken).email, 'jwt.cursor@example.com');

 // Expired token without refreshToken fails fast with AUTH_BOUNDARY without calling fetchUsage
 let fetchCount = 0;
 await assert.rejects(
  cursorQuota(undefined, {appData, fetchUsage:async()=>{fetchCount++;return Response.json({});}}),
  /AUTH_BOUNDARY/
 );
 assert.equal(fetchCount, 0);

 // Expired token with refreshToken triggers refreshCli and succeeds
 await writeFile(join(appData, 'Cursor', 'auth.json'), JSON.stringify({accessToken:expiredToken,refreshToken:'rt_cursor'}));
 const windows = await cursorQuota(undefined, {
  appData,
  refreshCli:async()=>{
   await writeFile(join(appData, 'Cursor', 'auth.json'), JSON.stringify({accessToken:freshToken,refreshToken:'rt_cursor'}));
  },
  fetchUsage:async(_url,options)=>{
   fetchCount++;
   assert.equal(options.headers.authorization, `Bearer ${freshToken}`);
   return Response.json({billingCycleEnd:'1796317670000',planUsage:{autoPercentUsed:10,apiPercentUsed:20}});
  }
 });
 assert.equal(fetchCount, 1);
 assert.equal(windows[0].remainingPercent, 90);

 // 429 Retry-After is classified as RATE_LIMIT
 await assert.rejects(
  cursorQuota(undefined, {
   appData,
   fetchUsage:async()=>new Response(null,{status:429,headers:{'retry-after':'45'}})
  }),
  err => {
   assert.equal(failure(err).code, 'RATE_LIMIT');
   assert.equal(err.retryAfterMs, 45_000);
   return true;
  }
 );

 // cursorAccount falls back to JWT identity when GetMe fails with 503
 const profile = await cursorAccount(undefined, {
  appData,
  fetchUsage:async()=>new Response(null,{status:503})
 });
 assert.equal(profile.email, 'jwt.cursor@example.com');
 assert.equal(profile.firstName, 'Cursor JWT');

 // Cursor reads ~/.cursor/cli-config.json (authInfo) for activeTeamId header and local identity fallback,
 // and supports exchanging apiKey via /auth/exchange_user_api_key when accessToken is expiring.
 const cursorConfigDir = await mkdtemp(join(tmpdir(), 'dsh-cursor-cfg-'));
 t.after(() => rm(cursorConfigDir, {recursive:true, force:true}));
 await writeFile(join(cursorConfigDir, 'cli-config.json'), JSON.stringify({
  authInfo:{email:'cliconfig@example.com',displayName:'CLI Config User',userId:42,activeTeamId:777}
 }));
 const standardCursorJwt = makeJwt({sub:'google-oauth2|u42',exp:Math.floor((Date.now()+3_600_000)/1000)});
 await writeFile(join(appData, 'Cursor', 'auth.json'), JSON.stringify({accessToken:standardCursorJwt}));
 const fallbackFromCliConfig = await cursorAccount(undefined, {
  appData,
  cursorConfigDir,
  fetchUsage:async()=>new Response(null,{status:502})
 });
 assert.equal(fallbackFromCliConfig.email, 'cliconfig@example.com');
 assert.equal(fallbackFromCliConfig.firstName, 'CLI Config User');

 // Verify activeTeamId header and apiKey exchange when accessToken is expiring within 5m
 const soonExpiringJwt = makeJwt({sub:'u42',exp:Math.floor((Date.now()+60_000)/1000)});
 await writeFile(join(appData, 'Cursor', 'auth.json'), JSON.stringify({accessToken:soonExpiringJwt,apiKey:'crsr_api_key_123'}));
 let sawTeamHeader = '';
 let sawClientHeader = '';
 const exchangedWindows = await cursorQuota(undefined, {
  appData,
  cursorConfigDir,
  fetchUsage:async(url, options)=>{
   if (url.endsWith('/auth/exchange_user_api_key')) {
    assert.equal(options.headers.authorization, 'Bearer crsr_api_key_123');
    return Response.json({accessToken:standardCursorJwt,refreshToken:'rt_new'});
   }
   sawTeamHeader = options.headers['x-cursor-team-id'];
   sawClientHeader = options.headers['x-cursor-client-type'];
   assert.equal(options.headers.authorization, `Bearer ${standardCursorJwt}`);
   return Response.json({billingCycleEnd:'1796317670000',planUsage:{autoPercentUsed:25,apiPercentUsed:50}});
  }
 });
 assert.equal(sawTeamHeader, '777');
 assert.equal(sawClientHeader, 'cli');
 assert.equal(exchangedWindows[0].remainingPercent, 75);
});

test('Antigravity and Cursor back off failed model catalog CLI spawns and avoid duplicate models check during parallel quota+catalog refresh', async t => {
 t.mock.timers.enable({apis:['Date'],now:new Date('2026-11-10T12:00:00Z')});
 let modelSpawns = 0;
 let usageSpawns = 0;
 const hub = createHub({
  cliDetect:() => ({command:'agy.exe',prefix:[]}),
  processRunner:async({args}) => {
   if (args.includes('models')) {
    modelSpawns++;
    return {code:1,stdout:'',stderr:'Error: Please sign in'};
   }
   usageSpawns++;
   return {code:0,stdout:'No quota rows',stderr:''};
  }
 });
 t.after(() => hub.dispose());
 const [cat, q] = await Promise.all([hub.catalogInfo('antigravity', true), hub.quota('antigravity', true)]);
 assert.equal(cat.error.code, 'AUTH');
 assert.equal(q.error.code, 'AUTH');
 assert.equal(modelSpawns, 1, 'parallel quota+catalog refresh must only spawn agy models once');
 assert.equal(usageSpawns, 1);

 // Calling catalog/visibleModels without force within the 60s retry window must not spawn CLI again
 await hub.visibleModels('antigravity');
 assert.equal(modelSpawns, 1);
});
