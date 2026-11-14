import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

function registrations(source) {
  let definition;const entries=[],effects=[];
  const React={createElement:(type,props,...children)=>({type,props,children}),forwardRef:fn=>fn,Fragment:'fragment'};
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load:plugin=>{definition=plugin;}}}});
  const plugin=definition.factory(name=>{assert.equal(name,'react');return React;});
  const dicts={};
  plugin.apply({
    effect:fn=>{const dispose=fn();if(dispose)effects.push(dispose);},
    locale:{register:(_ns,language,dict)=>{dicts[language]=dict;return()=>delete dicts[language];},bind:()=>key=>dicts.zh?.[key]||key},
    slots:{inject:(_slot,fn)=>fn(),register:(options,component)=>{entries.push({options,component});return()=>{};}}
  });
  return {entries,dispose:()=>effects.reverse().forEach(fn=>fn())};
}
const client=readFileSync(new URL('./client.js',import.meta.url),'utf8');

test('平台原生图标随 Client 内置，桌面协议无需额外静态图片请求',()=>{
  const match=client.match(/const PLATFORM_ICONS=\/\* @hub-icons \*\/ (.+);/);
  assert(match,'missing embedded icons');
  const icons=JSON.parse(match[1]);
  const files={deepseek:'deepseek.ico','workbuddy-cn':'workbuddy.svg',cursor:'cursor.svg',codex:'codex.png',antigravity:'antigravity.svg'};
  assert.equal(Object.keys(icons).length,5);
  for(const [id,file] of Object.entries(files)){
    assert.match(icons[id],/^data:image\/(?:x-icon|svg\+xml|png);base64,/);
    assert.deepEqual(Buffer.from(icons[id].split(',')[1],'base64'),readFileSync(new URL('./assets/platforms/'+file,import.meta.url)));
  }
  assert(!client.includes("src: '/plugins/dsh-ai-hub/assets/"));
});
test('模型管理独立注册左侧入口与匹配的主面板，无需办公室模块',()=>{
  const runtime=registrations(client);
  assert.equal(runtime.entries.length,2);
  const sidebar=runtime.entries.find(row=>row.options.name==='sidebar.panellist');
  const main=runtime.entries.find(row=>row.options.name==='main');
  assert.equal(sidebar.options.id,'model-management');assert.equal(main.options.key,sidebar.options.id);
  assert.equal(sidebar.options.label(),'模型管理');
  const panel=main.component();assert.equal(panel.children[0].type,'style');assert.equal(panel.children[1].type.name,'HubPage');
  assert(!client.includes('/plugins/dsh-ai-park'));assert(!client.includes('DEFAULT_PERSONA'));
  runtime.dispose();
});
test('独立面板保留模型、账号、用量入口及现有服务路径',()=>{
  assert(client.includes("const HUB_API = '/plugins/dsh-ai-hub/api'"));
  for(const title of ['总览','平台','用量','全部选中','取消全部选中'])assert(client.includes(title));
  assert(!client.includes('恢复常用'));
  assert(!client.includes('全部显示'));
  assert(!client.includes("['settings'"));
  assert(!client.includes('gatewayPanel'));
  assert(!client.includes("['routing'"));
  assert(!client.includes('routingView'));
  assert(client.includes('usageSnapshot'));
  assert(client.includes('usageReset'));
  assert(client.includes("action, ...extra"));
});
test('路由与营销文案移除，视觉不使用渐变、发光或大圆角',()=>{
  for(const text of ['路由','本地 AI 控制台','一切正常'])assert(!client.includes(text),text);
  assert(!/gradient|glow/i.test(client));
  assert(!/border-radius:\s*(?:1[1-9]|[2-9]\d)px/.test(client));
  assert(!/\p{Extended_Pictographic}/u.test(client.replace(/const PLATFORM_ICONS=.*\n/,'')));
  assert(client.includes('tabular-nums'));
});
test('平台页账号和用量 Tab 支持键盘切换且切换平台保持当前子 Tab，用量页不含额度卡片并保留范围、渠道、上下文与最近调用',()=>{
  for(const label of ["'account','账号'","'usage','用量'"])assert(client.includes(label),label);
  assert(client.includes("role:'tablist'"));
  for(const key of ['ArrowLeft','ArrowRight','Home','End'])assert(client.includes(`'${key}'`),key);
  for(const text of ["['today', '今日']","['7d', '7天']","['30d', '30天']","['all', '全部']",'上下文构成','渠道拆分','模型 × 强度','最近调用','暂无用量','包含测活'])assert(client.includes(text),text);
  for(const channel of ['chat','subagent','test','gateway','native'])assert(client.includes(`${channel}: '`),channel);
  assert(!client.includes('usageQuota('));
  assert(!/const choosePlatform=id=>\{[^}]*setBusinessTab/.test(client));
});
test('用量口径：实际与估算分列、P95 近似标注、原生输入未读取、模型搜索走服务端',()=>{
  assert(client.includes("'≈' + fmtMs(row.p95LatencyMs)"));
  assert(client.includes('`≈${fmtInt(row.estimatedInputTokens)}'));
  assert(client.includes("'未读取' : fmtInt(row.inputChars)"));
  assert(client.includes('model: model || undefined'));
  assert(client.includes('data.lastContext'));
  assert(client.includes("data.persistence === 'memory' ? '仅内存' : '已持久化'"));
  assert(!/inputTokens\s*\+\s*[\w.]*estimated/i.test(client),'estimated tokens must never be summed into actual');
});
test('用量导出只含元数据，清空需要二次确认，打开时与每 30 秒可见时刷新',()=>{
  const fields=client.match(/const usageExportFields = (\[[^\]]+\])/);
  assert(fields);
  const list=JSON.parse(fields[1].replace(/'/g,'"'));
  for(const forbidden of ['prompt','text','content','apiKey','key','inputText','outputText'])assert(!list.includes(forbidden),forbidden);
  assert(client.includes('导出 CSV')&&client.includes('导出 JSON'));
  assert(client.includes("h(ConfirmAction, { icon: 'trash', label: '清空统计'"));
  assert(client.includes("h(ConfirmAction, { icon: 'trash', label: '清除本平台'"));
  assert(client.includes("document.visibilityState !== 'hidden'")&&client.includes('}, 30000);'));
});
