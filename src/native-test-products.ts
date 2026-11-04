/** A successful build may attest only its freshly emitted plan and referenced product closure. */
import {readdir,lstat,realpath,readlink,unlink,writeFile} from 'node:fs/promises';
import {join,dirname,resolve,relative,sep} from 'node:path';
import {createHash} from 'node:crypto';
import {readFileBounded} from './bounded-file';
import {readXctestrun} from './sim/xctestrun';

const PLAN_LIMIT=8*1024*1024;
export interface TestBuildKey {sourceSha:string;project:string;scheme:string;configuration:string;onlyTesting:readonly string[];}
export interface PreparedTests extends TestBuildKey {buildOperationId:string;productsRoot:string;xctestrun:string;xctestrunHash:string;closure:Record<string,string>;targets:string[];manifestOnly:Record<string,string[]>;}
export type PlanSnapshot=Map<string,string>;
const under=(path:string,root:string)=>path===root || path.startsWith(root+sep);
const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export async function snapshotTestPlans(productsRoot:string):Promise<PlanSnapshot> {
  let names:string[];
  try {names=await readdir(productsRoot);}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return new Map();throw e;}
  const plans=names.filter(n=>n.endsWith('.xctestrun')).sort();
  if(plans.length>64)throw new Error('Too many test plans to attest.');
  const result=new Map<string,string>();
  for(const name of plans){const path=join(productsRoot,name);const info=await lstat(path,{bigint:true});if(!info.isFile())throw new Error('Test plans must be regular files.');const bytes=await readFileBounded(path,PLAN_LIMIT,{noFollow:true});result.set(path,[info.ino,info.mtimeNs,info.ctimeNs,digest(bytes)].join(':'));}
  return result;
}
export async function archiveOwnedTestPlans(productsRoot:string,owned:Map<string,string>,resultsRoot:string,operationId:string):Promise<void> {
  for(const [path,hash] of owned){
    if(dirname(path)!==productsRoot)throw new Error('Owned test plan escaped its products root.');
    let bytes:Buffer;
    try {bytes=await readFileBounded(path,PLAN_LIMIT,{noFollow:true});}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}
    if(digest(bytes)!==hash)throw new Error('Previously owned test plan changed before replacement.');
    await writeFile(join(resultsRoot,operationId+'.prior-'+createHash('sha256').update(path).digest('hex').slice(0,12)+'-'+hash+'.xctestrun'),bytes,{flag:'wx',mode:0o600});
    await unlink(path);
  }
}
/** Follow links too: changed bytes behind an unchanged test-product symlink invalidate reuse. */
async function hashProduct(path:string,root:string):Promise<string>{
  const hash=createHash('sha256');let count=0;
  const visit=async(current:string,label:string,ancestors:Set<string>):Promise<void>=>{
    if(++count>100000)throw new Error('Test product closure exceeds its entry limit.');
    const canonical=await realpath(current);if(!under(canonical,root))throw new Error('Test product resolves outside owned products.');
    if(ancestors.has(canonical))throw new Error('Cyclic test-product link.');
    const next=new Set(ancestors);next.add(canonical);const info=await lstat(current);hash.update(JSON.stringify(label));
    if(info.isSymbolicLink()){hash.update('link');hash.update(await readlink(current));await visit(canonical,label+'/@target',ancestors);return;}
    if(info.isDirectory()){hash.update('dir');for(const name of (await readdir(current)).sort())await visit(join(current,name),label+'/'+name,next);return;}
    if(!info.isFile())throw new Error('Unsupported test-product entry.');
    hash.update('file');hash.update(await readFileBounded(current,512*1024*1024,{noFollow:true}));
  };
  await visit(path,'',new Set());return hash.digest('hex');
}
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw new Error('Unsupported test plan structure.');return v as Record<string,unknown>;};
function targetEntries(plist:Record<string,unknown>):Array<Record<string,unknown>>{
  if(Array.isArray(plist.TestConfigurations))return plist.TestConfigurations.flatMap(c=>{const config=object(c);if(config.IsEnabled===false)return [];if(!Array.isArray(config.TestTargets))throw new Error('Test plan configuration has no targets.');return config.TestTargets.map(object);});
  return Object.entries(plist).filter(([k])=>!k.startsWith('__')&&k!=='ContainerInfo').map(([name,v])=>({...object(v),BlueprintName:name}));
}
export async function attestPreparedTests(key:TestBuildKey,productsRoot:string,before:PlanSnapshot,buildOperationId:string):Promise<PreparedTests>{
  if(await realpath(productsRoot)!==productsRoot)throw new Error('Test products root must be canonical.');
  const after=await snapshotTestPlans(productsRoot);const fresh=[...after].filter(([path,signature])=>before.get(path)!==signature).map(([path])=>path);
  if(fresh.length!==1)throw new Error('Build must freshly emit exactly one unambiguous xctestrun plan.');
  const xctestrun=fresh[0]!;const plist=object(await readXctestrun(xctestrun));
  const container=plist.ContainerInfo===undefined?null:object(plist.ContainerInfo);
  if(container?.SchemeName!==undefined && container.SchemeName!==key.scheme)throw new Error('Generated test plan scheme differs from the build.');
  const paths=new Set<string>();const targets:string[]=[];const manifestOnly:Record<string,string[]>=Object.create(null);
  const confined=async(value:unknown,host?:string,bundle?:string):Promise<string>=>{
    if(typeof value!=='string'||!value)throw new Error('Test product path is missing.');
    let expanded=value.split('__TESTROOT__').join(productsRoot);
    if(host)expanded=expanded.split('__TESTHOST__').join(host);if(bundle)expanded=expanded.split('__TESTBUNDLE__').join(bundle);
    if(/__[A-Z_]+__/.test(expanded))throw new Error('Unsupported test-product path placeholder.');
    const path=resolve(productsRoot,expanded);const canonical=await realpath(path);
    if(!under(path,productsRoot)||!under(canonical,productsRoot))throw new Error('Test plan references products outside the owned root.');
    // Hash the whole enclosing bundle when the plan names an executable within it.
    const parts=relative(productsRoot,path).split(sep);const boundary=parts.findIndex(p=>/\.(app|xctest|framework|bundle)$/.test(p));
    paths.add(boundary<0?path:join(productsRoot,...parts.slice(0,boundary+1)));return path;
  };
  for(const target of targetEntries(plist)){
    if(typeof target.BlueprintName!=='string'||!target.BlueprintName)throw new Error('Test target identity is missing.');
    targets.push(target.BlueprintName);
    const host=target.TestHostPath===undefined?undefined:await confined(target.TestHostPath);
    const bundle=await confined(target.TestBundlePath,host);
    if(!bundle.endsWith('.xctest') || !(await lstat(bundle)).isDirectory())throw new Error('Test plan must reference an existing test bundle.');
    if(target.UITargetAppPath!==undefined)await confined(target.UITargetAppPath,host,bundle);
    if(target.DependentProductPaths!==undefined){if(!Array.isArray(target.DependentProductPaths))throw new Error('Unsupported dependent product paths.');for(const path of target.DependentProductPaths)await confined(path,host,bundle);}
    if(target.OnlyTestIdentifiers!==undefined){if(!Array.isArray(target.OnlyTestIdentifiers)||target.OnlyTestIdentifiers.some(v=>typeof v!=='string'))throw new Error('Unsupported prepared test selection.');manifestOnly[target.BlueprintName]=(target.OnlyTestIdentifiers as string[]).map(v=>v.startsWith(target.BlueprintName+'/')?v:target.BlueprintName+'/'+v);}
  }
  if(!targets.length)throw new Error('Generated test plan has no enabled test targets.');
  for(const selection of key.onlyTesting)if(!targets.includes(selection.split('/')[0]!))throw new Error('Build selection does not match the emitted test targets.');
  const closure:Record<string,string>={};for(const path of [...paths].sort())closure[path]=await hashProduct(path,productsRoot);
  return {...key,onlyTesting:[...key.onlyTesting],buildOperationId,productsRoot,xctestrun,xctestrunHash:digest(await readFileBounded(xctestrun,PLAN_LIMIT,{noFollow:true})),closure,targets,manifestOnly};
}
const covered=(selection:string,scope:string)=>selection===scope||selection.startsWith(scope+'/');
export async function verifyPreparedTests(attestation:PreparedTests|undefined,key:TestBuildKey):Promise<PreparedTests>{
  if(!attestation)throw new Error('Test requires a successful matching build-for-testing attestation.');
  if(attestation.sourceSha!==key.sourceSha||attestation.project!==key.project||attestation.scheme!==key.scheme||attestation.configuration!==key.configuration)throw new Error('Test source/project/scheme/configuration differs from the successful build.');
  if(attestation.onlyTesting.length && (!key.onlyTesting.length || key.onlyTesting.some(s=>!attestation.onlyTesting.some(scope=>covered(s,scope)))))throw new Error('Requested test selection exceeds prepared build coverage.');
  for(const selection of key.onlyTesting){const target=selection.split('/')[0]!;if(!attestation.targets.includes(target))throw new Error('Requested test target was not prepared.');const allowed=attestation.manifestOnly[target];if(allowed?.length && !allowed.some(scope=>covered(selection,scope)))throw new Error('Requested tests exceed emitted plan coverage.');}
  if(digest(await readFileBounded(attestation.xctestrun,PLAN_LIMIT,{noFollow:true}))!==attestation.xctestrunHash)throw new Error('Prepared xctestrun changed.');
  for(const [path,hash] of Object.entries(attestation.closure))if(await hashProduct(path,attestation.productsRoot)!==hash)throw new Error('Prepared test products changed.');
  return attestation;
}
