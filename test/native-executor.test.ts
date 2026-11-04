import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { startWrappedBuild } from '../src/wrapped';
vi.mock('../src/wrapped',()=>({startWrappedBuild:vi.fn()}));
import type { WrappedDeps } from '../src/wrapped';
import { installNativeExecutor } from '../src/native-executor';
import { nativeExecuteInput, type LaneIdentity } from '../src/native-contract';
import { assertLegacyNativeAllowed, enterLegacyNative, enterNativeLane, leaveNativeLane } from '../src/native-gate';

type Rpc = Record<string,(input:unknown,ctx:{experimental_caller:{kind:string;pluginId?:string}})=>unknown>;
const atlas:{experimental_caller:{kind:string;pluginId?:string}}={experimental_caller:{kind:'plugin',pluginId:'atlas'}};
const dirs:string[]=[];
const devices:string[]=[];
afterEach(async()=>{for(const d of devices.splice(0))leaveNativeLane(d);leaveNativeLane('unreconciled-native-journal');await Promise.all(dirs.splice(0).map(p=>rm(p,{recursive:true,force:true})));});
async function setup() {
  const source=await realpath(await mkdtemp(join(tmpdir(),'xcode-source-')));dirs.push(source);
  const git=(...args:string[])=>execFileSync('/usr/bin/git',['-C',source,...args],{encoding:'utf8'}).trim();
  git('init','-q');await mkdir(join(source,'App.xcodeproj'));await writeFile(join(source,'App.xcodeproj','project.pbxproj'),'fixture');await writeFile(join(source,'README'),'source');git('add','.');git('-c','user.name=Native test','-c','user.email=native@example.invalid','commit','-qm','fixture');
  const threadId='thr_native_test_'+randomUUID();
  const owner=join(homedir(),'.bb','thread-storage',threadId);dirs.push(owner);
  const lane=join(owner,'native-lanes',randomUUID());
  const derivedData=join(lane,'DerivedData');const resultsRoot=join(lane,'results');
  await mkdir(derivedData,{recursive:true});await mkdir(resultsRoot);
  const dataDir=await mkdtemp(join(tmpdir(),'xcode-data-'));dirs.push(dataDir);
  const deviceId=randomUUID();devices.push(deviceId);
  const id:LaneIdentity={capability:'a'.repeat(64),operationId:randomUUID(),action:'open',threadId,deviceId,derivedData,sourceSha:git('rev-parse','HEAD')};
  const descriptor={ok:true,threadId,environmentId:'env-test',checkoutPath:source,hostId:'host-test',deviceId,derivedData,sourceSha:id.sourceSha,resultsRoot,compilerWorkers:2};
  let handlers:Rpc={};
  const validate=vi.fn(async()=>descriptor);
  const bb={rpc:{register:(_c:unknown,h:Rpc)=>{handlers=h;}},sdk:{plugins:{callRpc:validate},threads:{get:vi.fn(async()=>({id:threadId,environmentId:'env-test'}))},environments:{get:vi.fn(async()=>({path:source,hostId:'host-test'}))}},onDispose:vi.fn()} as unknown as BbPluginApi;
  await installNativeExecutor(bb,{dataDir} as WrappedDeps,async()=>'host-test');
  const invoke=(method:string,input:unknown={},ctx=atlas)=>handlers[method]!(input,ctx);
  const settled=async(operationId:string)=>{let result:unknown;await vi.waitFor(async()=>{result=await invoke('experimental_nativeStatus',{capability:id.capability,operationId});expect((result as {state:string}).state).not.toBe('running');});return result as {state:string;error:string|null};};
  return {id,descriptor,source,dataDir,validate,invoke,settled};
}
describe('native resource executor boundaries without native execution',()=>{
  it('requires explicit device and rejects caller identity in input',()=>{
    expect(nativeExecuteInput.safeParse({action:'capture'}).success).toBe(false);
  });
  it('requires an app identity for install, launch, drive and capture',async()=>{
    const f=await setup();
    for(const action of ['install','launch','drive','capture']) expect(nativeExecuteInput.safeParse({...f.id,action,steps:[{kind:'wait',ms:10}]}).success).toBe(false);
  });
  it('authenticates plugin caller independently of payload',async()=>{
    const f=await setup();
    expect(()=>f.invoke('experimental_nativeCapabilities',{}, {experimental_caller:{kind:'client'}})).toThrow('authenticated Atlas');
    await expect(f.invoke('experimental_nativeExecute',f.id,{experimental_caller:{kind:'plugin',pluginId:'other'}})).rejects.toThrow('authenticated Atlas');
    expect(f.validate).not.toHaveBeenCalled();
  });
  it('pins SDK checkout and holds legacy interlock until acknowledged close',async()=>{
    const f=await setup();await f.invoke('experimental_nativeExecute',f.id);
    expect((await f.settled(f.id.operationId)).state).toBe('passed');
    expect(()=>assertLegacyNativeAllowed()).toThrow('Atlas owns');
    const close={...f.id,action:'close',operationId:randomUUID()};
    await f.invoke('experimental_nativeExecute',close);expect((await f.settled(close.operationId)).state).toBe('passed');
    expect(()=>assertLegacyNativeAllowed()).not.toThrow();
    expect(f.validate.mock.calls.map(c=>(c as unknown as [{input:{phase:string}}])[0].input.phase)).toEqual(['begin','end','begin','end']);
  });
  it('retains busy fence when Atlas cannot acknowledge operation terminality',async()=>{
    const f=await setup();f.validate.mockImplementation(async(...args:unknown[])=>{
      if((args[0] as {input:{phase:string}}).input.phase==='end')throw new Error('validator unavailable');return f.descriptor;
    });
    await f.invoke('experimental_nativeExecute',f.id);
    expect((await f.settled(f.id.operationId)).state).toBe('fence-held');
    expect(()=>assertLegacyNativeAllowed()).toThrow();
    await expect(f.invoke('experimental_nativeExecute',{...f.id,action:'capture',operationId:randomUUID()})).rejects.toThrow('active operation');
  });
  it('fails source identity closed before any device operation',async()=>{
    const f=await setup();await writeFile(join(f.source,'README'),'dirty');await f.invoke('experimental_nativeExecute',f.id);
    const result=await f.settled(f.id.operationId);expect(result.state).toBe('failed');expect(result.error).toContain('clean');
    expect(()=>assertLegacyNativeAllowed()).not.toThrow();
  });
  it('does not expose status to another capability',async()=>{
    const f=await setup();await f.invoke('experimental_nativeExecute',f.id);await f.settled(f.id.operationId);
    expect(()=>f.invoke('experimental_nativeStatus',{operationId:f.id.operationId,capability:'b'.repeat(64)})).toThrow('capability');
  });
  it('mints exact build resources and retains busy ownership until cancellation actually settles',async()=>{
    const f=await setup();await f.invoke('experimental_nativeExecute',f.id);await f.settled(f.id.operationId);
    await mkdir(join(f.id.derivedData,'Build','Products','Debug-iphonesimulator'),{recursive:true});
    let finish!:(value:{failed:boolean;exitCode:number|null;signal:string|null;bundlePath:string;errors:number;warnings:number})=>void;
    let alive=true;
    vi.mocked(startWrappedBuild).mockImplementation(async(_deps,options)=>{
      options.onStart?.({pid:12345,bundlePath:join(f.descriptor.resultsRoot,'job.xcresult'),isAlive:()=>alive});
      return {bundlePath:join(f.descriptor.resultsRoot,'job.xcresult'),completed:new Promise(resolve=>{finish=resolve;})};
    });
    const build={...f.id,action:'build',operationId:randomUUID(),project:'App.xcodeproj',scheme:'App'};
    await f.invoke('experimental_nativeExecute',build);
    await vi.waitFor(async()=>{const status=await f.invoke('experimental_nativeStatus',{capability:f.id.capability,operationId:build.operationId});expect(startWrappedBuild,JSON.stringify(status)).toHaveBeenCalled();});
    const options=vi.mocked(startWrappedBuild).mock.calls.at(-1)![1];
    expect(options.argv).toContain('platform=iOS Simulator,id='+f.id.deviceId);
    expect(options.argv).toContain(f.id.derivedData);expect(options.argv).toContain(join(f.descriptor.resultsRoot,build.operationId+'.xcresult'));
    expect(options.argv).toContain('-parallel-testing-enabled');expect(options.argv).toContain('NO');expect(options.nativeFence).toBe(true);
    expect(await f.invoke('experimental_nativeActive')).toMatchObject({active:[{pid:12345,operationId:build.operationId,deviceId:f.id.deviceId,sourceSha:f.id.sourceSha}]});
    await f.invoke('experimental_nativeCancel',{capability:f.id.capability,operationId:build.operationId});
    expect(options.killSignal!.aborted).toBe(true);
    expect(await f.invoke('experimental_nativeStatus',{capability:f.id.capability,operationId:build.operationId})).toMatchObject({state:'running'});
    await expect(f.invoke('experimental_nativeExecute',{...f.id,action:'capture',operationId:randomUUID()})).rejects.toThrow('active operation');
    alive=false;finish({failed:false,exitCode:null,signal:'SIGTERM',bundlePath:'result',errors:0,warnings:0});
    expect((await f.settled(build.operationId)).state).toBe('cancelled');
    expect(await f.invoke('experimental_nativeActive')).toEqual({active:[]});
  });
  it('refuses capture/install of an app without a same-lane product receipt',async()=>{
    const f=await setup();await f.invoke('experimental_nativeExecute',f.id);await f.settled(f.id.operationId);
    for(const action of ['capture','install','launch','drive']) {
      const op={...f.id,action,bundleId:'app.example',steps:[{kind:'wait',ms:10}],operationId:randomUUID()};
      await f.invoke('experimental_nativeExecute',op);
      const result=await f.settled(op.operationId);expect(result.state).toBe('failed');expect(result.error).toContain('build product receipt');
    }
  });
  it('refuses an orphan journal and leaves legacy paths blocked after restart',async()=>{
    const dataDir=await mkdtemp(join(tmpdir(),'xcode-orphan-'));dirs.push(dataDir);await writeFile(join(dataDir,'native-resource-fence.json'),'[]');
    let handlers:Rpc={};const bb={rpc:{register:(_c:unknown,h:Rpc)=>handlers=h},onDispose:vi.fn()} as unknown as BbPluginApi;
    await installNativeExecutor(bb,{dataDir} as WrappedDeps,async()=>null);
    expect(()=>handlers.experimental_nativeCapabilities!({},atlas)).toThrow('reconciliation');expect(()=>assertLegacyNativeAllowed()).toThrow();
  });
  it('does not admit a lane while legacy work is active and permits disjoint lanes',()=>{
    const release=enterLegacyNative();try {expect(()=>enterNativeLane('first')).toThrow('active');} finally {release();}
    enterNativeLane('first');enterNativeLane('second');devices.push('first','second');expect(()=>enterNativeLane('first')).toThrow('busy');
  });
});
