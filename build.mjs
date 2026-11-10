import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('./',import.meta.url);const dicts={};for(const language of ['zh','en'])dicts[language]=JSON.parse((await readFile(new URL('locale/'+language+'.json',root),'utf8')).replace(/^\uFEFF/,'')).ui;
const file=new URL('client.js',root);const source=await readFile(file,'utf8');const marker=/^[ \t]*const DICTS=\/\* @hub-locales \*\/ [^\r\n]*/m;if(!marker.test(source))throw new Error('Locale marker missing');await writeFile(file,source.replace(marker,`  const DICTS=/* @hub-locales */ ${JSON.stringify(dicts)};`).replace(/^\uFEFF/,''));
const icons={};
for(const [id,name,type] of [['deepseek','deepseek.ico','image/x-icon'],['workbuddy-cn','workbuddy.svg','image/svg+xml'],['cursor','cursor.svg','image/svg+xml'],['codex','codex.png','image/png'],['antigravity','antigravity.svg','image/svg+xml']]){
 const bytes=await readFile(new URL('assets/platforms/'+name,root));
 icons[id]='data:'+type+';base64,'+bytes.toString('base64');
}
const current=await readFile(file,'utf8');const iconMarker=/^[ \t]*const PLATFORM_ICONS=\/\* @hub-icons \*\/ [^\r\n]*/m;
if(!iconMarker.test(current))throw new Error('Icon marker missing');
await writeFile(file,current.replace(iconMarker,`  const PLATFORM_ICONS=/* @hub-icons */ ${JSON.stringify(icons)};`));
