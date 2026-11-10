import assert from 'node:assert/strict';
import { readFile,stat,realpath,writeFile } from 'node:fs/promises';
import { resolve,dirname,sep,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root=dirname(fileURLToPath(import.meta.url));
const read=async path=>(await readFile(join(root,path),'utf8')).replace(/^\uFEFF/,'');
const pkg=JSON.parse(await read('package.json'));
assert.equal(pkg.name,'dsh-ai-hub');assert.equal(pkg.type,'module');assert(!pkg.dependencies&&!pkg.scripts?.install);assert.equal(pkg.dsh.bundle.patch,'./cordis.patch.yml');assert.equal(pkg.exports['./client'],'./client.js');assert.equal(pkg.exports['./locale/*.json'],'./locale/*.json');assert.equal(pkg.exports['./icon'],'./icon.svg');assert.equal(pkg.dsh.client.platform,'web');assert(pkg.dsh.client.immediately);
const distributed=new Set(pkg.files.filter(p=>!p.includes('*')));distributed.add('locale/zh.json');distributed.add('locale/en.json');
for(const path of distributed){const full=await realpath(join(root,path));assert(full.startsWith(root+sep),'Distribution path escaped package');assert((await stat(full)).isFile());}
for(const path of Object.values(pkg.exports).filter(p=>!p.includes('*')))assert(distributed.has(path.slice(2)),`Export missing from files: ${path}`);
assert((await read('cordis.patch.yml')).trimStart().startsWith('- insert:'));
const rows=[];let current;
// Validate this deliberately restricted YAML subset, rejecting unrecognized syntax.
for(const line of (await read('cordis.patch.yml')).split(/\r?\n/)){
 if(!line.trim()||line.trim().startsWith('#')||line==='- insert:')continue;
 let match=line.match(/^    - id: ([\w-]+)$/);if(match){current={id:match[1],config:{}};rows.push(current);continue;}
 match=line.match(/^      name: (.+)$/);if(match){assert(current);current.name=match[1].replace(/^['"]|['"]$/g,'');continue;}
 if(/^      config:(?: \{\})?$/.test(line))continue;
 match=line.match(/^        (\w+): ([\w-]+)$/);if(match){assert(current);current.config[match[1]]=match[2];continue;}
 throw new Error('Unsupported patch syntax: '+line);
}
assert.equal(rows.length,4);assert.equal(new Set(rows.map(r=>r.id)).size,4);assert.equal(rows[0].name,pkg.name);
for(const p of ['cursor','antigravity','workbuddy']){const row=rows.find(r=>r.config.provider===p);assert.equal(row.name,'@deepseek-ai/dsh-tool-subagent');assert.equal(row.config.toolName,'subagent_'+p);assert.equal(row.config.maxDepth,'provider-managed');assert(row.id.startsWith('ai-hub-'));}
const locales={};for(const language of ['zh','en']){const d=JSON.parse(await read('locale/'+language+'.json'));assert(d.meta.title&&d.meta.description);assert(!/template|my plugin/i.test(d.meta.title));locales[language]=d.ui;}
assert.deepEqual(Object.keys(locales.zh).sort(),Object.keys(locales.en).sort());
const client=await read('client.js');const embedded=client.match(/const DICTS=\/\* @hub-locales \*\/ ([^\r\n]+);/);assert(embedded);assert.deepEqual(JSON.parse(embedded[1]),locales);
for(const m of client.matchAll(/tr\('([^']+)'\)/g))assert(m[1] in locales.en,`Missing locale key ${m[1]}`);
assert.deepEqual([...client.matchAll(/require\('([^']+)'\)/g)].map(m=>m[1]),['react']);
assert(client.includes('ctx.locale.register(NS,language,dict)'));
assert(client.includes("id:'model-management'"));assert(client.includes("key:'model-management'"));
assert(!client.includes('/plugins/dsh-ai-park'));
assert(!client.includes('onContextMenu'));assert(!client.includes('shell.overlay'));
const css=client.match(/const css=`([\s\S]*?)`;/)?.[1];assert(css&&css.includes('var(--dsw-'),'Client must use host theme tokens');
assert(!/@import|url\(\s*['"]?https?:/i.test(css),'No remote style dependencies');
assert(!/appendChild|createRoot|iframe|puppeteer|playwright|cua_repl/.test(client));
const svg=await read('icon.svg');assert(svg.trim().startsWith('<svg')&&svg.trim().endsWith('</svg>'));assert((await stat(join(root,'icon.svg'))).size<=256*1024);assert(!/href=|<script|<foreignObject/.test(svg));
const modules=[...distributed].filter(p=>/\.(mjs|js)$/.test(p));
for(const file of modules){const source=await read(file);for(const m of source.matchAll(/from\s+['"]([^'"]+)['"]/g)){if(m[1].startsWith('node:'))continue;assert(m[1].startsWith('./'),`Unexpected dependency: ${m[1]}`);assert(distributed.has(m[1].slice(2)),`Missing distribution module: ${m[1]}`);}const result=spawnSync(process.execPath,['--check',join(root,file)],{encoding:'utf8',windowsHide:true});assert.equal(result.status,0,result.stderr);}
const result={ok:true,checks:{manifest:true,patchSubset:true,uniqueRows:rows.map(r=>r.id),displayResources:true,locales:true,themeTokens:true,onlyReactClientImport:true,nodeCheck:modules},limitations:'Static bundle/subset validation only; no installation, live Loader, browser, DOM or visual verification.'};await writeFile(join(root,'evidence','validation.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
