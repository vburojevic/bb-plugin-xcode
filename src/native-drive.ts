/** Exact-device drive input policy over the canonical HID + simulator pasteboard APIs. */
import {HidSocket,NAMED_KEYS,normalizeOrientation,sleep} from './sim/hid';
import {executeStep,type ResolvePoint,type Step} from './sim/steps';
import type {DeviceDriver} from './sim/devices';

/** Reject knowably lossy input for the whole batch before any UI mutation. */
export function preflightNativeDrive(steps:readonly Step[]):void {
  for(const [index,step] of steps.entries()) {
    if(step.kind==='type')for(const character of step.text) {
      const scalar=character.codePointAt(0)!;
      if(scalar>=0xd800 && scalar<=0xdfff)throw new Error(`Drive step ${index+1} contains malformed Unicode; no input was sent.`);
      if((scalar<32 && scalar!==9 && scalar!==10) || scalar>=127 && scalar<=159)throw new Error(`Drive step ${index+1} contains an unsupported control character; only LF and tab controls are supported. No input was sent.`);
    }
    if(step.kind==='key' && !Object.prototype.hasOwnProperty.call(NAMED_KEYS,step.name.trim().toLowerCase()))throw new Error(`Drive step ${index+1} names an unsupported key. No input was sent.`);
    if(step.kind==='rotate' && normalizeOrientation(step.orientation)===null)throw new Error(`Drive step ${index+1} names an unsupported orientation. No input was sent.`);
  }
}
export async function executeNativeDrive(input:{
  deviceId:string;steps:readonly Step[];socket:HidSocket;resolve:ResolvePoint;
  driver:Pick<DeviceDriver,'pbcopy'>;signal:AbortSignal;
  ensureDevice:(deviceId:string)=>Promise<void>;
  onStep:(log:string)=>void;
}):Promise<void> {
  preflightNativeDrive(input.steps);
  for(const [index,step] of input.steps.entries()) {
    input.signal.throwIfAborted();
    const result=await executeStep(input.socket,step,input.resolve,{
      pasteText:async(text)=>{
        // Use the whole string. Never partially type ASCII before pasting Unicode.
        await input.ensureDevice(input.deviceId);input.signal.throwIfAborted();
        await input.driver.pbcopy(input.deviceId,text,input.signal);
        // Same sync boundary as canonical LiveService.pasteText; never use host clipboard.
        await sleep(150);input.signal.throwIfAborted();
        await input.socket.pasteChord();
      },
    });
    if(result.dropped.length)throw new Error(`Drive step ${index+1} dropped ${result.dropped.length} character(s); partial input may have occurred. Drive failed and no success capture is accepted.`);
    input.signal.throwIfAborted();input.onStep(result.log);
  }
}
