import {execFileSync} from 'node:child_process';
import {readFile,mkdir,appendFile,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {activate,deactivate,noLinks,parseRevitCompatibility,assertRevitCompatibility} from './lifecycle.mjs';

// Narrow installer helper. No user-controlled shell text and no client config mutation.
const mode=process.argv[2],release=JSON.parse(await readFile(new URL('./release.json',import.meta.url),'utf8'));
if(!['check','install','check-uninstall','uninstall'].includes(mode))throw Error('Unknown installer action.');
const compatibility=parseRevitCompatibility(release.revitCompatibility);
const root=join(process.env.LOCALAPPDATA,'Programs','DatummAgent');
const addins=join(process.env.APPDATA,'Autodesk','Revit','Addins',String(compatibility.year));
const releaseDir=join(root,'releases',release.version);
const logDir=join(process.env.LOCALAPPDATA,'DatummAgent');
async function guard(){
 if(process.platform!=='win32')throw Error('Windows x64 required.');
 const powershell=join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
 const processCheck="$ErrorActionPreference='Stop'; if(Get-Process Revit -ErrorAction SilentlyContinue){throw 'Close Revit before installation or removal. The installer will not close your models.'}; ";
 const command=processCheck+(['check','install'].includes(mode)?`$api=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Autodesk/Revit ${compatibility.year}/RevitAPI.dll'; if(!(Test-Path -LiteralPath $api)){throw 'Revit ${compatibility.year} must be installed.'}; (Get-Item -LiteralPath $api).VersionInfo.FileVersion`:'\'uninstall-preflight\'');
 let version;try{version=execFileSync(powershell,['-NoLogo','-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',windowsHide:true,timeout:15000,stdio:['ignore','pipe','pipe']}).trim();}
 catch(e){throw Error(e.stderr?.toString().includes('Close Revit')?'Close Revit before installing or removing DATUMM.':'Could not verify the installed Revit build.');}
 assertRevitCompatibility(mode,version,compatibility);
}
try{
 await guard();
 if(mode==='check'){
  await noLinks(root);await noLinks(releaseDir);await noLinks(addins);
  try{const info=await lstat(root);if(info.isSymbolicLink())throw Error('Installation root cannot be a link.');
   const names=await readdir(root);if(names.length&&!names.includes('installation.json'))throw Error('Existing application directory is unmanaged; inspect it before installing.');
   if(names.includes('installation.json')){const state=JSON.parse(await readFile(join(root,'installation.json'),'utf8'));if(state.owner!=='datumm-agent-packaged')throw Error('Existing application directory is not owned by DATUMM.');
    if(state.version===release.version){const expected=await readFile(new URL('./release-manifest.json',import.meta.url));if(state.payloadHash!==createHash('sha256').update(expected).digest('hex'))throw Error('This version is already installed with different payload bytes. Increment the package version instead of overwriting it.');}
   }
  }catch(e){if(e.code!=='ENOENT')throw e;}
 }else{
  const ctx={root,addins,releaseDir,guard};
  if(mode==='install'){
   if(resolve(fileURLToPath(import.meta.url))!==resolve(releaseDir,'setup.mjs'))throw Error('Installer payload is not in the fixed application directory.');
   await activate(ctx);
  }else await deactivate(ctx,{checkOnly:mode==='check-uninstall'});
 }
 await mkdir(logDir,{recursive:true});await appendFile(join(logDir,'installer.log'),`${new Date().toISOString()} ${mode} ${release.version} OK\n`);
}catch(e){await mkdir(logDir,{recursive:true});await appendFile(join(logDir,'installer.log'),`${new Date().toISOString()} ${mode} FAILED ${e.message}\n`);console.error(e.message);process.exitCode=1;}
