import {describe,expect,it} from 'vitest';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {MAX_NATIVE_RECEIPT_BYTES,saveNativePngReceipt,writeNativeReceipt} from '../src/native-evidence';

describe('native iteration evidence',()=>{
  it('binds original PNG bytes to source, actor, app product and operation without capabilities',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'native-evidence-'));
    try {
      const image=join(dir,'frame.png');const bytes=Buffer.from([137,80,78,71,13,10,26,10]);await writeFile(image,bytes);
      const proof={operationId:'operation',deviceId:'device',sourceSha:'a'.repeat(40),environmentId:'environment',threadId:'thread',hostId:'host',appProductHash:'b'.repeat(64),foregroundBundleId:'app.example'};
      await saveNativePngReceipt(image,proof,1234);
      const receipt=JSON.parse(await readFile(image+'.json','utf8'));
      expect(receipt).toEqual({...proof,pngSha256:createHash('sha256').update(bytes).digest('hex'),capturedAt:1234,role:'iteration-only',foregroundVerified:true});
      expect(await readFile(image)).toEqual(bytes);
      await expect(saveNativePngReceipt(image,proof,1234)).rejects.toThrow();
    } finally {await rm(dir,{recursive:true,force:true});}
  });
  it('rejects oversized receipts and nested capability fields before writing',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'native-evidence-'));const path=join(dir,'receipt.json');
    try {
      await expect(writeNativeReceipt(path,{nested:{capability:'secret'}})).rejects.toThrow('capability');
      await expect(writeNativeReceipt(path,{value:'x'.repeat(MAX_NATIVE_RECEIPT_BYTES)})).rejects.toThrow('bounded');
      await expect(readFile(path)).rejects.toThrow();
    } finally {await rm(dir,{recursive:true,force:true});}
  });
});
