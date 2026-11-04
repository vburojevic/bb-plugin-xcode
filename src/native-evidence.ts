import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { readFileBounded } from './bounded-file';

export const MAX_NATIVE_RECEIPT_BYTES=64*1024;
export async function writeNativeReceipt(path:string,value:Record<string,unknown>):Promise<void> {
  const body=JSON.stringify(value, (key,item)=>{
    if(key==='capability')throw new Error('Native evidence must never contain a capability.');
    return item;
  });
  if(Buffer.byteLength(body)>MAX_NATIVE_RECEIPT_BYTES)throw new Error('Native evidence receipt exceeds its bounded size.');
  await writeFile(path,body,{flag:'wx',mode:0o600});
}
export async function saveNativePngReceipt(imagePath:string,provenance:{operationId:string;deviceId:string;sourceSha:string;environmentId:string;threadId:string;hostId:string;appProductHash:string;foregroundBundleId:string},capturedAt:number):Promise<void> {
  const png=await readFileBounded(imagePath,32*1024*1024,{noFollow:true});
  await writeNativeReceipt(imagePath+'.json',{...provenance,pngSha256:createHash('sha256').update(png).digest('hex'),capturedAt,role:'iteration-only',foregroundVerified:true});
}
