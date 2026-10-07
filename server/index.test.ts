// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
const lifecycle=vi.hoisted(()=>({handlers:new Map<string,()=>void>(),shutdown:vi.fn(),release:vi.fn(async()=>{}),close:vi.fn((callback:()=>void)=>callback()),closeAllConnections:vi.fn()}));
vi.mock('./config.ts',()=>({readConfig:()=>({port:0,host:'127.0.0.1',timeoutMs:100,sttTimeoutMs:100})}));
vi.mock('./providers.ts',()=>({createAIServices:()=>({liveSpeech:{release:lifecycle.release}})}));
vi.mock('./app.ts',()=>({createApp:()=>({shutdown:lifecycle.shutdown,listen:()=>({close:lifecycle.close,closeAllConnections:lifecycle.closeAllConnections,on:vi.fn()})})}));
afterEach(()=>{vi.restoreAllMocks();vi.useRealTimers();vi.resetModules();lifecycle.handlers.clear();vi.clearAllMocks();});
it('waits application settlement and speech release before graceful exit, including repeated signals',async()=>{
 let settle!:()=>void;const gate=new Promise<void>(resolve=>settle=resolve);lifecycle.shutdown.mockReturnValue(gate);
 vi.spyOn(process,'on').mockImplementation(((event:string,handler:()=>void)=>{lifecycle.handlers.set(event,handler);return process;}) as typeof process.on);
 const exit=vi.spyOn(process,'exit').mockImplementation(()=>undefined as never);vi.useFakeTimers();
 await import('./index.ts');lifecycle.handlers.get('SIGINT')!();lifecycle.handlers.get('SIGTERM')!();
 await Promise.resolve();expect(exit).not.toHaveBeenCalled();expect(lifecycle.shutdown).toHaveBeenCalledOnce();
 settle();await vi.waitFor(()=>expect(exit).toHaveBeenCalledWith(0));expect(lifecycle.release).toHaveBeenCalledOnce();expect(lifecycle.close).toHaveBeenCalledOnce();
});
it('forces bounded exit when background shutdown does not settle',async()=>{
 lifecycle.shutdown.mockReturnValue(new Promise(()=>{}));
 vi.spyOn(process,'on').mockImplementation(((event:string,handler:()=>void)=>{lifecycle.handlers.set(event,handler);return process;}) as typeof process.on);
 const exit=vi.spyOn(process,'exit').mockImplementation(()=>undefined as never);vi.useFakeTimers();
 await import('./index.ts');lifecycle.handlers.get('SIGTERM')!();await vi.advanceTimersByTimeAsync(10000);
 expect(lifecycle.closeAllConnections).toHaveBeenCalledOnce();expect(exit).toHaveBeenCalledWith(1);
});
