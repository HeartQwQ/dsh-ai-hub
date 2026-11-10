import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createLoginActions, loginCommand } from './login-actions.mjs';

test('DeepSeek 复用 Host 授权服务及本机可信回调地址',async()=>{
  let args;const state={status:'signed-out',attempt:{id:'fixture',phase:'initializing'}};
  const actions=createLoginActions({getAccount:()=>({startSignIn:async(...input)=>{args=input;return state;}}),getOrigin:()=> 'http://127.0.0.1:4289'});
  assert.deepEqual(await actions.startDeepseek(),state);assert.equal(args[1],'http://127.0.0.1:4289');assert.equal(args[2],'desktop');assert.equal(args[0].locale,'zh-CN');
});
test('回调地址不能被替换为外部服务或带凭据的 URL',async()=>{
  for(const origin of ['https://example.invalid','http://127.0.0.1','http://user:secret@localhost:1234','http://localhost:1234/path','http://localhost:1234/?redirect=x']){
    const actions=createLoginActions({getAccount:()=>({startSignIn:()=>{throw Error('must not call');}}),getOrigin:()=>origin});
    await assert.rejects(actions.startDeepseek(),/本机 HTTP/);
  }
});
test('取消只传递当前授权会话 ID，不读取或复制登录凭据',async()=>{
  let id;const actions=createLoginActions({getAccount:()=>({cancelSignIn:async value=>{id=value;return{status:'signed-out'};}})});
  await actions.cancelDeepseek('attempt-fixture');assert.equal(id,'attempt-fixture');await assert.rejects(actions.cancelDeepseek(''),/无效/);
});
test('缺失账号能力时明确报错，不虚构登录成功',async()=>{
  const actions=createLoginActions({getAccount:()=>undefined});await assert.rejects(actions.startDeepseek(),/不支持/);await assert.rejects(actions.cancelDeepseek('id'),/不支持/);
});
test('切换 DeepSeek 账号先退出，退出失败时停止授权', async () => {
  const calls = [];
  let status = 'credential-stored';
  const actions = createLoginActions({getOrigin:()=> 'http://127.0.0.1:4289',getAccount:()=>({
    signOut: async () => { calls.push('logout'); return {status}; },
    startSignIn: async () => { calls.push('login'); return {status:'signed-out'}; }
  })});
  await assert.rejects(actions.startDeepseek(true), /未能退出/);
  assert.deepEqual(calls,['logout']);
  status = 'signed-out';
  await actions.startDeepseek(true);
  assert.deepEqual(calls,['logout','logout','login']);
});
test('CLI 登录限定平台、固定参数并正确转义含引号的路径',()=>{
  const cli={command:"C:\\O'Neil\\node.exe",prefix:['C:\\Cursor CLI\\index.js']};
  const cursor=loginCommand('cursor',cli);assert(cursor.includes("'C:\\O''Neil\\node.exe'"));assert(cursor.endsWith("'login'"));
  assert(loginCommand('codex',{command:'codex.exe'}).endsWith("'login'"));
  assert.equal(loginCommand('antigravity',{command:'agy.exe'}),"& 'agy.exe'");
  assert.match(loginCommand('cursor',cli,true), /'logout'; if \(\$LASTEXITCODE -eq 0\).*'login'/);
  assert.match(loginCommand('codex',{command:'codex.exe'},true), /'logout'; if \(\$LASTEXITCODE -eq 0\).*'login'/);
  assert.match(loginCommand('antigravity',{command:'agy.exe'},true), /\/logout.*& 'agy.exe'$/);
  assert.throws(()=>loginCommand('custom',cli),/不支持/);
});
test('登录必须收到新终端确认，不能把 helper spawn 当作窗口打开',async()=>{
  let call,child;
  const actions=createLoginActions({os:'win32',systemRoot:'C:\\Windows',detectCLI:()=>({command:'codex.exe',prefix:[]}),launch:(...args)=>{
    call=args;child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();return child;
  }});
  let settled=false;const pending=actions.openPlatform('codex').then(value=>{settled=true;return value;});
  child.emit('spawn');await Promise.resolve();assert.equal(settled,false);
  assert.equal(call[2].windowsHide,true);assert.deepEqual(call[2].stdio,['ignore','pipe','pipe']);
  const script=Buffer.from(call[1].at(-1),'base64').toString('utf16le');assert(script.includes('Start-Process'));assert(script.includes('-WindowStyle Normal'));assert(script.includes('-PassThru'));
  child.stdout.emit('data',JSON.stringify({requested:true,processId:1234,windowConfirmed:false}));child.emit('close',0);
  const result=await pending;assert.equal(result.started,true);assert.equal(result.windowConfirmed,false);assert.equal(result.processId,1234);
  const failed=createLoginActions({os:'win32',detectCLI:()=>({command:'cursor.exe'}),launch:()=>{const value=new EventEmitter();queueMicrotask(()=>value.emit('error',Error('spawn failed')));return value;}});
  await assert.rejects(failed.openPlatform('cursor'),/spawn failed/);
});
test('helper 成功退出但没有终端确认时也不能返回成功',async()=>{
 const actions=createLoginActions({os:'win32',detectCLI:()=>({command:'agy.exe'}),launch:()=>{const child=new EventEmitter();child.stdout=new EventEmitter();queueMicrotask(()=>{child.stdout.emit('data','{}');child.emit('close',0);});return child;}});
 await assert.rejects(actions.openPlatform('antigravity'),/有效启动确认/);
});
test('不支持系统和任意平台不能启动进程',async()=>{
  let launched=false;
  const actions=createLoginActions({os:'linux',launch:()=>{launched=true;}});
  await assert.rejects(actions.openPlatform('codex'),/当前系统/);await assert.rejects(actions.openPlatform('__proto__'),/不支持/);assert.equal(launched,false);
});
