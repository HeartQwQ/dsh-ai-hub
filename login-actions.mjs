import { spawn } from 'node:child_process';
import { join } from 'node:path';

const LOGIN_ARGS = { cursor: ['login'], codex: ['login'], antigravity: [] };
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";
const encode = value => Buffer.from(value,'utf16le').toString('base64');
export function terminalLaunchScript(command,title,powershell) {
  const session = `$Host.UI.RawUI.WindowTitle = ${quote(title)}+' ['+$PID+']'; ${command}`;
  return `$ErrorActionPreference='Stop'; $child=Start-Process -FilePath ${quote(powershell)} -ArgumentList @('-NoLogo','-NoProfile','-NoExit','-EncodedCommand',${quote(encode(session))}) -WindowStyle Normal -PassThru; $expectedTitle=${quote(title)}+' ['+$child.Id+']'; $windowFound=$false; for($i=0;$i -lt 15;$i++){Start-Sleep -Milliseconds 100; $child.Refresh(); if($child.HasExited){throw 'Interactive terminal exited immediately'}; $windowFound=@(Get-Process -ErrorAction SilentlyContinue | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq $expectedTitle}).Count -gt 0; if($child.MainWindowHandle -ne 0 -or $windowFound){break}}; @{requested=$true; processId=$child.Id; windowConfirmed=($child.MainWindowHandle -ne 0 -or $windowFound)} | ConvertTo-Json -Compress`;
}
export function loginCommand(platform, cli, switchAccount = false) {
  if (!Object.hasOwn(LOGIN_ARGS, platform)) throw new Error('不支持的平台登录方式');
  const command = '& ' + [cli.command, ...(cli.prefix || [])].map(quote).join(' ');
  const login = [command, ...LOGIN_ARGS[platform].map(quote)].join(' ');
  if (!switchAccount) return login;
  if (platform === 'antigravity') {
    return `Write-Host ${quote('在 AGY 内输入 /logout 退出，再运行 agy 并用另一个 Google 账号登录。')}; ${login}`;
  }
  return `${command} 'logout'; if ($LASTEXITCODE -eq 0) { ${login} }`;
}
export function createLoginActions({ getAccount, getOrigin, detectCLI, launch = spawn, os = process.platform, systemRoot = process.env.SystemRoot || 'C:\\Windows' }) {
  const client = () => ({ version: '0.2.2-rc.1', locale: 'zh-CN', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
  return {
    async startDeepseek(switchAccount = false) {
      const account = getAccount();
      if (typeof account?.startSignIn !== 'function') throw new Error('当前 Host 不支持 DeepSeek 账号登录');
      const origin = getOrigin();
      const url = new URL(origin);
      if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('DeepSeek 登录需要本机 HTTP 回调服务');
      const metadata = client();
      if (switchAccount) {
        if (typeof account.signOut !== 'function') throw new Error('当前 Host 不支持切换 DeepSeek 账号');
        const state = await account.signOut(metadata);
        if (state?.status !== 'signed-out') throw new Error('未能退出当前 DeepSeek 账号');
      }
      return account.startSignIn(metadata, url.origin, 'desktop');
    },
    async cancelDeepseek(id) {
      if (typeof id !== 'string' || !id || id.length > 160) throw new Error('无效的登录会话');
      const account = getAccount();
      if (typeof account?.cancelSignIn !== 'function') throw new Error('当前 Host 不支持取消登录');
      return account.cancelSignIn(id);
    },
    async openPlatform(platform, switchAccount = false) {
      if (!Object.hasOwn(LOGIN_ARGS, platform)) throw new Error('不支持的平台登录方式');
      if (os !== 'win32') throw new Error('当前系统请使用登录命令完成授权');
      const cli = detectCLI(platform);
      const command = loginCommand(platform, cli, switchAccount);
      // A detached child with ignored stdio may have no console under Electron.
      // A hidden helper explicitly creates a separate, visible interactive window.
      const powershell=join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const script=terminalLaunchScript(command,'DSH - '+platform+' login',powershell);
      const child=launch(powershell,['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',encode(script)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
      const result=await new Promise((resolve,reject)=>{
        let output='',settled=false;
        const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);error?reject(error):resolve(value);};
        const timer=setTimeout(()=>{child.kill?.();done(new Error('无法确认登录终端是否已启动，请复制登录命令到系统终端运行'));},8000);
        child.stdout?.on('data',chunk=>{output+=String(chunk);if(output.length>8192){child.kill?.();done(new Error('登录终端启动响应异常'));}});
        child.stderr?.on('data',()=>{});
        child.once('error',error=>done(error));
        child.once('close',code=>{try{if(code!==0)throw new Error('登录终端启动失败，请复制登录命令到系统终端运行');const value=JSON.parse(output.trim());if(value.requested!==true||!Number.isInteger(value.processId)||value.processId<=0)throw new Error('登录终端未返回有效启动确认');done(null,value);}catch(error){done(error);}});
      });
      return { started:true,requested:true,platform,method:'terminal',processId:result.processId,windowConfirmed:result.windowConfirmed===true };
    }
  };
}
