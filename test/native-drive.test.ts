import {describe,expect,it,vi} from 'vitest';
import type {HidSocket} from '../src/sim/hid';
import {coordinatesOnly,type Step} from '../src/sim/steps';
import {executeNativeDrive,preflightNativeDrive} from '../src/native-drive';
function fixture(steps:Step[]) {
  const events:string[]=[];const abort=new AbortController();
  const socket={type:vi.fn(async(text:string)=>{events.push('type:'+text);return {dropped:[] as string[]};}),tap:vi.fn(async()=>{events.push('tap');}),pasteChord:vi.fn(async()=>{events.push('paste');})};
  const pbcopy=vi.fn(async(device:string,text:string,signal?:AbortSignal)=>{expect(device).toBe('exact-udid');expect(signal).toBe(abort.signal);events.push('pbcopy:'+text);});
  const ensureDevice=vi.fn(async(device:string)=>{expect(device).toBe('exact-udid');events.push('verify-device');});
  const onStep=vi.fn();
  const run=()=>executeNativeDrive({deviceId:'exact-udid',steps,socket:socket as unknown as HidSocket,resolve:coordinatesOnly,driver:{pbcopy},signal:abort.signal,ensureDevice,onStep});
  return {run,socket,pbcopy,ensureDevice,onStep,events,abort};
}
describe('native exact-device drive input',()=>{
  it('sends supported ASCII through HID without touching any pasteboard',async()=>{
    const f=fixture([{kind:'type',text:'Hello!\tLine\n'}]);await f.run();expect(f.socket.type).toHaveBeenCalledWith('Hello!\tLine\n');expect(f.pbcopy).not.toHaveBeenCalled();expect(f.onStep).toHaveBeenCalledOnce();
  });
  it('pastes accented, combining and emoji text as one exact-device string',async()=>{
    const text='café e\u0301 🙂';const f=fixture([{kind:'type',text}]);await f.run();expect(f.socket.type).not.toHaveBeenCalled();expect(f.events).toEqual(['verify-device','pbcopy:'+text,'paste']);expect(f.onStep).toHaveBeenCalledOnce();
  });
  it.each(['before\rafter','before\0after','before\bafter','before\x7fafter','before\u0085after','before\ud800after'])('refuses an entire lossy batch before its earlier tap: %j',async(text)=>{
    const f=fixture([{kind:'tap',at:{x:0.5,y:0.5}},{kind:'type',text}]);await expect(f.run()).rejects.toThrow();expect(f.socket.tap).not.toHaveBeenCalled();expect(f.socket.type).not.toHaveBeenCalled();expect(f.pbcopy).not.toHaveBeenCalled();expect(f.onStep).not.toHaveBeenCalled();
  });
  it('stops on unexpected HID character loss instead of accepting a partial flow',async()=>{
    const f=fixture([{kind:'type',text:'ASCII'},{kind:'tap',at:{x:0.5,y:0.5}}]);f.socket.type.mockResolvedValue({dropped:['I']});await expect(f.run()).rejects.toThrow('partial input');expect(f.socket.tap).not.toHaveBeenCalled();expect(f.onStep).not.toHaveBeenCalled();
  });
  it('does not paste or proceed when the canonical device pasteboard refuses',async()=>{
    const f=fixture([{kind:'type',text:'🙂'},{kind:'tap',at:{x:0.5,y:0.5}}]);f.pbcopy.mockRejectedValue(new Error('pasteboard unavailable'));await expect(f.run()).rejects.toThrow('pasteboard unavailable');expect(f.socket.pasteChord).not.toHaveBeenCalled();expect(f.socket.tap).not.toHaveBeenCalled();expect(f.onStep).not.toHaveBeenCalled();
  });
  it('does not issue the paste chord after cancellation during pasteboard synchronization',async()=>{
    const f=fixture([{kind:'type',text:'é'}]);f.pbcopy.mockImplementation(async()=>{f.abort.abort();});await expect(f.run()).rejects.toThrow();expect(f.socket.pasteChord).not.toHaveBeenCalled();expect(f.onStep).not.toHaveBeenCalled();
  });
  it('preflights unsupported named keys and orientations before earlier gestures',()=>{
    for(const step of [{kind:'key',name:'__proto__'},{kind:'key',name:'unknown'},{kind:'rotate',orientation:'sideways'}] as const)expect(()=>preflightNativeDrive([{kind:'tap',at:{x:0.5,y:0.5}},step])).toThrow('No input was sent');
  });
});
