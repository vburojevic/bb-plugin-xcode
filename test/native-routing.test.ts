import {describe,expect,it,vi} from 'vitest';
import {makeCaptureTool,makeDriveTool} from '../src/sim/tools';
import type {Ctx} from '../src/sim/context';

describe('legacy exact-device selection refuses mismatch',()=>{
  for(const kind of ['capture','drive'] as const)it(kind+' cannot silently use globally selected device',async()=>{
    const acquire=vi.fn(()=>{throw new Error('must not take a lease for another device');});
    const ctx={settings:()=>({allowAgentCapture:true}),live:{currentDevice:()=>({udid:'11111111-1111-4111-8111-111111111111'})},leases:{acquire}} as unknown as Ctx;
    const args={udid:'22222222-2222-4222-8222-222222222222',steps:[{kind:'wait' as const,ms:10}]};
    const tool=kind==='capture'?makeCaptureTool(ctx):makeDriveTool(ctx);
    const result=await tool.execute(args,{threadId:'thread-test'});
    expect(result.isError).toBe(true);expect(acquire).not.toHaveBeenCalled();expect(result.content[0]).toMatchObject({type:'text',text:expect.stringContaining('exact simulator')});
  });
});
