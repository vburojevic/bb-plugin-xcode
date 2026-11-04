import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {archiveOwnedTestPlans,attestPreparedTests,snapshotTestPlans,verifyPreparedTests,type TestBuildKey} from '../src/native-test-products';
vi.mock('../src/sim/xctestrun',()=>({readXctestrun:async(path:string)=>JSON.parse(await (await import('node:fs/promises')).readFile(path,'utf8'))}));
const dirs:string[]=[];afterEach(async()=>{await Promise.all(dirs.splice(0).map(d=>rm(d,{recursive:true,force:true})));});
async function fixture(){
  const root=await realpath(await mkdtemp(join(tmpdir(),'prepared-products-')));dirs.push(root);const products=join(root,'Products');await mkdir(products);
  const bundle=join(products,'Debug-iphonesimulator','Tests.xctest');await mkdir(bundle,{recursive:true});await writeFile(join(bundle,'Tests'),'built binary');
  const plan=join(products,'App.xctestrun');const target={BlueprintName:'Tests',TestBundlePath:'__TESTROOT__/Debug-iphonesimulator/Tests.xctest'};
  const emit=async(extra:Record<string,unknown>={})=>writeFile(plan,JSON.stringify({ContainerInfo:{SchemeName:'App'},TestConfigurations:[{TestTargets:[{...target,...extra}]}]}));
  const key:TestBuildKey={sourceSha:'a'.repeat(40),project:join(root,'App.xcodeproj'),scheme:'App',configuration:'Debug',onlyTesting:[]};
  return {root,products,bundle,plan,emit,key};
}
describe('prepared test product provenance',()=>{
  it('rejects an outside test bundle and links escaping owned products',async()=>{
    const f=await fixture();const outside=join(f.root,'Outside.xctest');await mkdir(outside);await f.emit({TestBundlePath:outside});
    await expect(attestPreparedTests(f.key,f.products,new Map(),'build')).rejects.toThrow('outside');
    await f.emit();await writeFile(join(f.root,'outside-binary'),'unowned');await symlink(join(f.root,'outside-binary'),join(f.bundle,'External'));
    await expect(attestPreparedTests(f.key,f.products,new Map(),'build')).rejects.toThrow('outside');
  });
  it('binds dependent products and emitted plan selection coverage',async()=>{
    const f=await fixture();const dependent=join(f.products,'Dependency.dylib');await writeFile(dependent,'built dependency');await f.emit({DependentProductPaths:['__TESTROOT__/Dependency.dylib'],OnlyTestIdentifiers:['Case/testA']});
    const prepared=await attestPreparedTests(f.key,f.products,new Map(),'build');
    await expect(verifyPreparedTests(prepared,{...f.key,onlyTesting:['Tests/Case/testA']})).resolves.toBe(prepared);
    await expect(verifyPreparedTests(prepared,{...f.key,onlyTesting:['Tests/Case']})).rejects.toThrow('coverage');
    await writeFile(dependent,'changed dependency');await expect(verifyPreparedTests(prepared,f.key)).rejects.toThrow('products changed');
  });
  it('verifies the documented hosted plan closure without admitting unrelated retained apps',async()=>{
    const f=await fixture();const app=join(f.products,'Debug-iphonesimulator','App.app');await mkdir(join(app,'PlugIns','Tests.xctest'),{recursive:true});await writeFile(join(app,'App'),'host binary');await writeFile(join(app,'PlugIns','Tests.xctest','Tests'),'hosted tests');
    await writeFile(f.plan,JSON.stringify({Tests:{TestHostPath:'__TESTROOT__/Debug-iphonesimulator/App.app',TestBundlePath:'__TESTHOST__/PlugIns/Tests.xctest'}}));
    const prepared=await attestPreparedTests(f.key,f.products,new Map(),'build');expect(Object.keys(prepared.closure)).toEqual([app]);
    await writeFile(join(app,'App'),'changed host');await expect(verifyPreparedTests(prepared,f.key)).rejects.toThrow('products changed');
  });
  it('does not select an arbitrary old or ambiguous freshly emitted plan',async()=>{
    const f=await fixture();await f.emit();const before=await snapshotTestPlans(f.products);
    await expect(attestPreparedTests(f.key,f.products,before,'build')).rejects.toThrow('freshly emit');
    await writeFile(join(f.products,'Other.xctestrun'),await readFile(f.plan));await expect(attestPreparedTests(f.key,f.products,new Map(),'build')).rejects.toThrow('exactly one');
  });
  it('archives/removes only exact owned manifests while retaining products and unowned plans',async()=>{
    const f=await fixture();await f.emit();const original=await readFile(f.plan);const hash=createHash('sha256').update(original).digest('hex');
    const unowned=join(f.products,'Unowned.xctestrun');await writeFile(unowned,'unowned');const results=join(f.root,'results');await mkdir(results);
    await archiveOwnedTestPlans(f.products,new Map([[f.plan,hash]]),results,'operation');
    await expect(readFile(f.plan)).rejects.toThrow();expect(await readFile(unowned,'utf8')).toBe('unowned');expect(await readFile(join(f.bundle,'Tests'),'utf8')).toBe('built binary');
    const files=await readdir(results);expect(files).toHaveLength(1);expect(await readFile(join(results,files[0]!))).toEqual(original);
  });
});
