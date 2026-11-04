import type { BbPluginApi } from '@get-bb/plugin-sdk';
import { mkdir, readFile, realpath, writeFile, unlink, readdir, lstat, readlink } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { nativeContract, laneDescriptor, laneValidationInput, nativeExecuteInput, type LaneIdentity, type LaneDescriptor, type NativeJob } from './native-contract';
import { enterNativeLane, leaveNativeLane, assertLegacyNativeIdle } from './native-gate';
import { validateBuildArguments } from './build-security';
import { startWrappedBuild, type WrappedDeps } from './wrapped';
import { DeviceDriver } from './sim/devices';
import { HidSocket } from './sim/hid';
import { executeStep, coordinatesOnly } from './sim/steps';
import { flatten, findByLabel, describeMiss } from './sim/ax';
import { startSimHost, resolveSimHostPath, type SimHostHandle } from './sim/sim-host-sup';
import * as host from './sim/sim-host-client';
import { z } from 'zod';
import { saveNativePngReceipt, writeNativeReceipt } from './native-evidence';
import { createHash } from 'node:crypto';

const exec = promisify(execFile);
interface Lane { identity: LaneIdentity; descriptor: LaneDescriptor; busy: boolean; host: SimHostHandle | null; socket: HidSocket | null; products:Map<string,{path:string;hash:string}>; }
interface Job { identity: LaneIdentity; value: NativeJob; abort: AbortController; done: Promise<void>; isAlive:()=>boolean; terminal:boolean; }
const failure = (e: unknown) => e instanceof Error ? e.message : String(e);
const atlasOnly = (caller: {kind:string;pluginId?:string}) => {
  if (caller.kind !== 'plugin' || caller.pluginId !== 'atlas') throw new Error('Only the authenticated Atlas plugin may execute native resource jobs.');
};

/** No TTLs, selected-device fallback, freeform commands or caller-asserted checkout. */
export async function installNativeExecutor(bb: BbPluginApi, wrapped: WrappedDeps, serverHost: () => Promise<string | null>): Promise<void> {
  const lanes = new Map<string,Lane>();
  const jobs = new Map<string,Job>();
  const closed = new Map<string,Lane>();
  const released = new Map<string,{threadId:string;deviceId:string;descriptor:LaneDescriptor}>();
  const releaseFile=join(wrapped.dataDir,'native-resource-releases.json');
  try {
    const entries=z.array(z.tuple([z.string().regex(/^[a-f0-9]{64}$/),z.object({threadId:z.string(),deviceId:z.string().uuid(),descriptor:laneDescriptor}).strict()])).parse(JSON.parse(await readFile(releaseFile,'utf8')));
    for(const [key,value] of entries)released.set(key,value);
  } catch(e) {if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
  const releaseKey=(id:{capability:string;threadId:string;deviceId:string})=>createHash('sha256').update(JSON.stringify([id.capability,id.threadId,id.deviceId.toUpperCase()])).digest('hex');
  const journal = join(wrapped.dataDir, 'native-resource-fence.json');
  let orphaned = false;
  try { await readFile(journal); orphaned = true; enterNativeLane('unreconciled-native-journal'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  let journalWrite = Promise.resolve();
  const persist = () => {
    const body = JSON.stringify([...lanes.values(),...closed.values()].map(l => ({...l.identity, capability: undefined, descriptor:l.descriptor,closed:closed.has(l.identity.deviceId)})));
    journalWrite = journalWrite.then(async () => {
      await mkdir(wrapped.dataDir,{recursive:true});
      await writeFile(releaseFile,JSON.stringify([...released.entries()]),{mode:0o600});
      if (body === '[]') await unlink(journal).catch(e => {if(e.code !== 'ENOENT') throw e;});
      else { await mkdir(wrapped.dataDir,{recursive:true}); await writeFile(journal,body,{mode:0o600}); }
    });
    return journalWrite;
  };
  const validate = async (identity:LaneIdentity, phase:'begin'|'end', outcome?:'passed'|'failed'|'cancelled') => {
    const input = laneValidationInput.parse({capability:identity.capability,operationId:identity.operationId,action:identity.action,threadId:identity.threadId,deviceId:identity.deviceId,derivedData:identity.derivedData,sourceSha:identity.sourceSha,phase,...(outcome ? {outcome}: {})});
    return await bb.sdk.plugins.callRpc({pluginId:'atlas',method:'experimental_validateNativeLane',input,outputSchema:laneDescriptor});
  };
  const resolveStaticActor = async (id:{threadId:string}, d:LaneDescriptor) => {
    const thread = await bb.sdk.threads.get({threadId:id.threadId});
    if (thread.id!==id.threadId || !thread.environmentId || thread.environmentId !== d.environmentId || d.threadId !== id.threadId) throw new Error('Native lane thread/environment changed.');
    const environment = await bb.sdk.environments.get({environmentId:thread.environmentId});
    const local = await serverHost();
    if (!local || environment.hostId !== local || d.hostId !== local) throw new Error('Native lane host cannot be verified as this server.');
    if (!environment.path) throw new Error("Native environment has no checkout path.");
    const path = await realpath(environment.path);
    if (path !== d.checkoutPath || path !== await realpath(d.checkoutPath)) throw new Error('Native lane checkout changed.');
    const storage=await bb.sdk.threads.storageLocation({threadId:thread.id});
    if(storage.hostId!==local)throw new Error('Native thread storage must be on the verified local host.');
    if(dirname(dirname(d.derivedData))!==join(storage.storageRootPath,'native-lanes'))throw new Error('Native SDK thread storage identity changed.');
    return {path,storageRoot:storage.storageRootPath};
  };
  const resolveIdentity = async (id:LaneIdentity, d:LaneDescriptor) => {
    const {path,storageRoot}=await resolveStaticActor(id,d);
    if (d.deviceId !== id.deviceId || d.derivedData !== id.derivedData || d.sourceSha !== id.sourceSha) throw new Error('Native resource descriptor mismatch.');
    const head = await exec('/usr/bin/git',['-C',path,'rev-parse','HEAD']);
    if (head.stdout.trim() !== id.sourceSha) throw new Error('Native lane source SHA changed.');
    // Capture requires exact source, so refuse a tracked dirty tree as well.
    const dirty = await exec('/usr/bin/git',['-C',path,'status','--porcelain']);
    if (dirty.stdout.trim()) throw new Error('Native lane checkout must be clean at its pinned source SHA.');
    const ownerRoot=join(storageRoot,'native-lanes');
    const laneRoot=dirname(id.derivedData);
    if (dirname(laneRoot)!==ownerRoot || !z.string().uuid().safeParse(laneRoot.split('/').at(-1)).success || id.derivedData!==join(laneRoot,'DerivedData') || d.resultsRoot!==join(laneRoot,'results')) throw new Error('Native products must use the authoritative thread storage lane namespace.');
    for (const owned of [ownerRoot,laneRoot,id.derivedData,d.resultsRoot]) if (await realpath(owned)!==owned) throw new Error('Native owned paths may not traverse symlinks.');
    if (laneRoot===path || laneRoot.startsWith(path+'/') || path.startsWith(laneRoot+'/')) throw new Error('Native source and owned products must be disjoint.');
  };
  const getJob = (input:{capability:string;operationId:string}) => {
    const job = jobs.get(input.operationId);
    if (!job || job.identity.capability !== input.capability) throw new Error('Unknown native operation or capability.');
    return job;
  };
  const driver = new DeviceDriver();
  const ensureDevice = async (id:string) => {
    driver.invalidateBooted();
    if (!(await driver.bootedUdids()).has(id)) throw new Error('The exact lane simulator must already be booted by Atlas.');
  };
  const socketFor = async (lane:Lane) => {
    await ensureDevice(lane.identity.deviceId);
    if (lane.host && !lane.host.isAlive()) throw new Error('Native lane capture host exited; close and reacquire the lane.');
    if (!lane.host) {
      lane.host = await startSimHost({execPath:process.execPath,simHostPath:resolveSimHostPath(import.meta.url).path,env:process.env},{onExit:()=>{},onLog:m=>bb.log.info(m)});
      await host.startDevice(lane.host,lane.identity.deviceId);
      const socket = new HidSocket({port:lane.host.port,secret:lane.host.secret,udid:lane.identity.deviceId,onConfig:()=>{},onClose:()=>{lane.socket=null;}});
      await socket.open(); lane.socket = socket;
    }
    if (!lane.socket) throw new Error('Native lane HID socket is unavailable.');
    return lane.socket;
  };
  const productFor = async (lane:Lane,bundleId:string) => {
    const product=lane.products.get(bundleId);
    if(!product || await treeHash(product.path)!==product.hash) throw new Error('No matching exact-source build product receipt.');
    return product;
  };
  const attestInstalled = async (lane:Lane,bundleId:string,signal:AbortSignal) => {
    const product=await productFor(lane,bundleId);
    const installed=await exec('/usr/bin/xcrun',['simctl','get_app_container',lane.identity.deviceId,bundleId,'app'],{signal});
    if(await treeHash(installed.stdout.trim())!==product.hash) throw new Error('Installed app differs from the exact-source lane build product.');
  };
  const attestForeground = async (lane:Lane,bundleId:string) => {
    await socketFor(lane);
    const foreground=await host.foregroundApp(lane.host!,lane.identity.deviceId);
    if(foreground.bundleId!==bundleId) throw new Error('Expected exact-source app is not the verified foreground application.');
  };
  const perform = async (input:z.infer<typeof nativeExecuteInput>, lane:Lane, job:Job) => {
    const d=lane.descriptor;
    if (input.action === 'open') return;
    if (input.action === 'close') {
      lane.socket?.close(); lane.host?.stop();
      return;
    }
    if (input.action === 'build' || input.action === 'test') {
      const project=resolve(d.checkoutPath,input.project!);
      if (!project.endsWith('.xcodeproj') && !project.endsWith('.xcworkspace')) throw new Error('A project or workspace path is required.');
      const bundle=join(d.resultsRoot,input.operationId+'.xcresult');
      const argv=['/usr/bin/xcodebuild',project.endsWith('.xcworkspace')?'-workspace':'-project',project,'-scheme',input.scheme!,'-configuration',input.configuration??'Debug','-destination',`platform=iOS Simulator,id=${input.deviceId}`,'-derivedDataPath',input.derivedData,'-resultBundlePath',bundle,'-jobs',String(d.compilerWorkers),'-parallel-testing-enabled','NO','-maximum-concurrent-test-simulator-destinations','1',`OTHER_SWIFT_FLAGS=$(inherited) -j${d.compilerWorkers} -num-threads 1`,...(input.onlyTesting??[]).map(v=>'-only-testing:'+v),input.action==='build'?'build-for-testing':'test-without-building'];
      await validateBuildArguments(["/usr/bin/xcodebuild",project.endsWith(".xcworkspace")?"-workspace":"-project",project],d.checkoutPath,d.checkoutPath);
      job.value.bundlePath=bundle;
      job.terminal=false;
      const started=await startWrappedBuild(wrapped,{argv,cwd:d.checkoutPath,killSignal:job.abort.signal,nativeFence:true,onStart:info=>{job.value.pid=info.pid;job.isAlive=info.isAlive;}});
      if (!started) throw new Error('Native build runner refused to start.');
      const result=await started.completed;
      if (!result.failed) job.terminal=true;
      if (result.failed || result.exitCode !== 0 || result.errors) throw new Error('Native build/test failed; inspect its tracked result bundle.');
      const products=join(input.derivedData,'Build','Products',(input.configuration??'Debug')+'-iphonesimulator');
      for(const entry of await readdir(products,{withFileTypes:true})) {
        if(!entry.isDirectory() || !entry.name.endsWith('.app')) continue;
        const app=join(products,entry.name);
        const bundle=await exec('/usr/bin/plutil',['-extract','CFBundleIdentifier','raw','-o','-',join(app,'Info.plist')]);
        lane.products.set(bundle.stdout.trim(),{path:app,hash:await treeHash(app)});
      }
      await resolveIdentity(input,d);
      await writeNativeReceipt(join(d.resultsRoot,input.operationId+'.build.json'),{operationId:input.operationId,deviceId:input.deviceId,sourceSha:input.sourceSha,environmentId:d.environmentId,threadId:input.threadId,hostId:d.hostId,derivedData:input.derivedData,resultBundlePath:bundle,action:input.action==='build'?'build-for-testing':'test-without-building',compilerWorkers:d.compilerWorkers,swiftDriverFlagsRequested:`-j${d.compilerWorkers} -num-threads 1`,swiftWorkerCapVerified:false,pid:job.value.pid,appProducts:[...lane.products.entries()].map(([bundleId,p])=>({bundleId,path:p.path,sha256:p.hash})),completedAt:Date.now(),role:'iteration-only'});
      return;
    }
    if (!input.bundleId) throw new Error('Device execution requires an attested app bundle ID.');
    await productFor(lane,input.bundleId);
    await ensureDevice(input.deviceId);
    if (input.action === 'install') {
      const product=await productFor(lane,input.bundleId);
      await exec('/usr/bin/xcrun',['simctl','install',input.deviceId,product.path],{signal:job.abort.signal});
      await attestInstalled(lane,input.bundleId,job.abort.signal);
      return;
    }
    await attestInstalled(lane,input.bundleId,job.abort.signal);
    if (input.action === 'launch') {
      await exec('/usr/bin/xcrun',['simctl','launch',input.deviceId,input.bundleId],{signal:job.abort.signal});
      return;
    }
    await attestForeground(lane,input.bundleId);
    if (input.action === 'drive') {
      const socket=await socketFor(lane);
      for (const step of input.steps!) {
        job.abort.signal.throwIfAborted();
        const resolvePoint = async (point:Parameters<typeof coordinatesOnly>[0]) => {
          if ('x' in point) return point;
          const tree=flatten(await host.accessibility(lane.host!,input.deviceId));
          const match=findByLabel(tree,point.element.label);
          if (!match) throw new Error(describeMiss(tree,point.element.label));
          return match.point;
        };
        const result=await executeStep(socket,step,resolvePoint);
        job.value.log.push(result.log);
      }
    }
    await attestInstalled(lane,input.bundleId,job.abort.signal);
    await attestForeground(lane,input.bundleId);
    // Unaltered PNG evidence, never dependent on a global live selection.
    const imagePath=join(d.resultsRoot,input.operationId+'.png');
    await exec('/usr/bin/xcrun',['simctl','io',input.deviceId,'screenshot',imagePath],{signal:job.abort.signal});
    const product=await productFor(lane,input.bundleId);
    await resolveIdentity(input,d);
    await saveNativePngReceipt(imagePath,{operationId:input.operationId,deviceId:input.deviceId,sourceSha:input.sourceSha,environmentId:d.environmentId,threadId:input.threadId,hostId:d.hostId,appProductHash:product.hash,foregroundBundleId:input.bundleId},Date.now());
    job.value.imagePath=imagePath;
  };
  bb.rpc.register(nativeContract,{
    experimental_nativeCapabilities(_input,ctx) {
      atlasOnly(ctx.experimental_caller);
      if (orphaned) throw new Error('Native lane journal needs explicit reconciliation after plugin restart.');
      assertLegacyNativeIdle();
      return {version:2 as const,exactDevice:true as const,fencing:true as const,managedRuns:true as const,legacyInterlock:true as const};
    },
    experimental_nativeActive(_input,ctx) {
      atlasOnly(ctx.experimental_caller);
      return {active:[...jobs.values()].filter(j=>j.isAlive() && j.value.pid!==null).map(j=>({pid:j.value.pid!,operationId:j.identity.operationId,deviceId:j.identity.deviceId,threadId:j.identity.threadId,derivedData:j.identity.derivedData,sourceSha:j.identity.sourceSha,hostId:lanes.get(j.identity.deviceId)!.descriptor.hostId}))};
    },
    async experimental_nativeExecute(input,ctx) {
      atlasOnly(ctx.experimental_caller);
      if (orphaned) throw new Error('Native lane journal needs explicit reconciliation after plugin restart.');
      if (jobs.has(input.operationId)) throw new Error('Native operation IDs cannot be reused.');
      let lane=lanes.get(input.deviceId);
      let reopening:Lane|undefined;
      if (input.action === 'open') {
        if (lane) throw new Error('Native device is already held.');
        const prior=closed.get(input.deviceId);
        if(prior) {
          if(prior.busy || prior.identity.capability!==input.capability || prior.identity.threadId!==input.threadId)throw new Error('Closed native custody belongs to another actor or is busy.');
          reopening=prior;closed.delete(input.deviceId);
        } else enterNativeLane(input.deviceId);
        lane={identity:input,descriptor:null as unknown as LaneDescriptor,busy:true,host:null,socket:null,products:new Map()};
        lanes.set(input.deviceId,lane);
      } else {
        if (!lane || lane.identity.capability !== input.capability || lane.identity.threadId !== input.threadId || lane.identity.derivedData !== input.derivedData || lane.identity.sourceSha !== input.sourceSha) throw new Error('No matching open native lane.');
        if (lane.busy) throw new Error('Native lane already has an active operation.');
        lane.busy=true;
      }
      const held=lane;
      const value:NativeJob={operationId:input.operationId,deviceId:input.deviceId,state:'running',pid:null,bundlePath:null,imagePath:null,error:null,log:[]};
      const job:Job={identity:input,value,abort:new AbortController(),done:Promise.resolve(),isAlive:()=>false,terminal:true};
      jobs.set(input.operationId,job);
      job.done=(async()=>{
        let began=false;
        let outcome:'passed'|'failed'|'cancelled'='failed';
        try {
          // Persist before any external operation. A crash leaves an explicit recovery hold.
          await persist();
          if(reopening)await resolveStaticActor(input,reopening.descriptor);
          const descriptor=await validate(input,'begin'); began=true;
          if (input.action !== 'open' && JSON.stringify(held.descriptor) !== JSON.stringify(descriptor)) throw new Error('Native lane descriptor changed.');
          held.descriptor=descriptor;
          if(input.action==='close')await resolveStaticActor(input,descriptor);else await resolveIdentity(input,descriptor);
          await persist();
          job.abort.signal.throwIfAborted();
          await perform(input,held,job);
          if(input.action==='close')await resolveStaticActor(input,held.descriptor);else await resolveIdentity(input,held.descriptor);
          outcome=job.abort.signal.aborted?'cancelled':'passed';
        } catch(e) {value.error=failure(e); outcome=job.abort.signal.aborted?'cancelled':'failed';}
        try {
          if (!job.terminal) throw new Error('Native process terminality is unverified; Atlas fence remains held.');
          if (began) await validate(input,'end',outcome);
          value.state=outcome;
          job.isAlive=()=>false;
          held.busy=false;
          if (input.action==='close' && outcome==='passed' || input.action==='open' && outcome!=='passed') {
            held.socket?.close();held.host?.stop();held.socket=null;held.host=null;held.products.clear();
            lanes.delete(input.deviceId);closed.set(input.deviceId,held);
          }
          try { await persist(); } catch(e) {if(!closed.has(input.deviceId))lanes.set(input.deviceId,held);throw e;}
        } catch(e) {
          // Never let an expired token, disconnected validator or failed journal free a live resource.
          value.state='fence-held';value.error=[value.error,failure(e)].filter(Boolean).join('; ');held.busy=true;
        }
      })();
      return {...value,log:[...value.log]};
    },
    async experimental_nativeRelease(input,ctx) {
      atlasOnly(ctx.experimental_caller);
      const prior=released.get(releaseKey(input));
      if(prior) {
        await resolveStaticActor(input,prior.descriptor);
        return {released:true as const}; // An old tombstone never mutates a newer lane/gate.
      }
      if(orphaned)throw new Error('Native lane journal needs explicit reconciliation after plugin restart.');
      const custody=closed.get(input.deviceId);
      if(lanes.has(input.deviceId) || !custody || custody.busy)throw new Error('Release requires idle closed native custody.');
      if(custody.identity.capability!==input.capability || custody.identity.threadId!==input.threadId)throw new Error('Native custody actor or capability mismatch.');
      if([...jobs.values()].some(j=>j.identity.deviceId===input.deviceId && (j.value.state==='running' || j.value.state==='fence-held' || j.isAlive())))throw new Error('Native operation terminality is unverified.');
      custody.busy=true;
      try {
        await resolveStaticActor(input,custody.descriptor);
        const device=(await driver.list()).find(d=>d.udid.toUpperCase()===input.deviceId.toUpperCase());
        if(!device || device.state!=='Shutdown')throw new Error('Release requires the exact simulator to be verified Shutdown.');
        closed.delete(input.deviceId);
        released.set(releaseKey(input),{threadId:input.threadId,deviceId:input.deviceId,descriptor:custody.descriptor});
        try {await persist();}catch(e){closed.set(input.deviceId,custody);released.delete(releaseKey(input));throw e;}
        leaveNativeLane(input.deviceId);
        return {released:true as const};
      } finally {custody.busy=false;}
    },
    experimental_nativeStatus(input,ctx) {atlasOnly(ctx.experimental_caller);const j=getJob(input);return {...j.value,log:[...j.value.log]};},
    experimental_nativeCancel(input,ctx) {atlasOnly(ctx.experimental_caller);const j=getJob(input);if(j.value.state==='running')j.abort.abort();return {...j.value,log:[...j.value.log]};},
  });
  bb.onDispose(async()=>{
    // Keep journal and Atlas busy proof until terminality is acknowledged. No detached builds on this route.
    for(const j of jobs.values()) if(j.value.state==='running') j.abort.abort();
    await Promise.allSettled([...jobs.values()].map(j=>j.done));
    for(const l of lanes.values()){l.socket?.close();l.host?.stop();}
  });
}

/** Hash relative names, entry kinds, link targets and original bytes without rewriting the app. */
async function treeHash(root:string):Promise<string> {
  const hash=createHash('sha256');
  const visit=async(relative:string):Promise<void>=>{
    const path=join(root,relative);const stat=await lstat(path);
    hash.update(JSON.stringify(relative));
    if(stat.isSymbolicLink()) {hash.update('link');hash.update(await readlink(path));return;}
    if(stat.isDirectory()) {hash.update('dir');for(const name of (await readdir(path)).sort())await visit(join(relative,name));return;}
    if(!stat.isFile())throw new Error('Unsupported app product entry.');
    hash.update('file');hash.update(await readFile(path));
  };
  await visit('');return hash.digest('hex');
}
