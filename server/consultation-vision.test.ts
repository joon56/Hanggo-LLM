// @vitest-environment node
import { expect,it,vi,afterEach } from 'vitest';
import { visionSceneTimes,visionFrameTimes } from '../src/domain/consultation-vision.ts';
import { createConsultationVision } from './consultation-vision.ts';
import { readConfig } from './config.ts';
import type { LlmProvider, LlmRequest } from './ai/llm/types.ts';
const fakeLlm=(supportsVision:boolean,structured:(request:LlmRequest)=>Promise<{json:unknown;finished:boolean}>=async()=>({json:{observations:[]},finished:true})):LlmProvider=>({name:'fake',supportsVision,structured,release:async()=>{}});
afterEach(()=>vi.unstubAllGlobals());
it('samples every 30 seconds and bookmarks within 240 scenes and never samples past duration',()=>{
 expect(visionSceneTimes(60001,[{atMs:1234}])).toEqual([0,1234,30000,60000]);expect(()=>visionSceneTimes(3600000,Array.from({length:150},(_,i)=>({atMs:i*1000+1})))).toThrow();expect(visionFrameTimes(0,100)).toEqual([0,99]);expect(()=>visionSceneTimes(3600000,Array.from({length:241},(_,i)=>({atMs:i})))).toThrow();
});
it('refuses images when the selected model has no vision support',async()=>{
 const structured=vi.fn(async()=>({json:{observations:[]},finished:true}));
 await expect(createConsultationVision(readConfig(),fakeLlm(false,structured)).analyze([Buffer.from([255,216])],new AbortController().signal)).rejects.toThrow('does not support vision');expect(structured).not.toHaveBeenCalled();
});
it('sends images through the provider and preserves empty observation output',async()=>{
 let request:LlmRequest|undefined;const frame=Buffer.from([255,216]);
 expect(await createConsultationVision(readConfig(),fakeLlm(true,async value=>{request=value;return {json:{observations:[]},finished:true};})).analyze([frame],new AbortController().signal)).toEqual([]);expect(request?.images).toEqual([frame]);expect(request?.maxTokens).toBe(1024);
});
it('rejects incomplete or differently shaped vision output',async()=>{
 const analyze=(json:unknown,finished=true)=>createConsultationVision(readConfig(),fakeLlm(true,async()=>({json,finished}))).analyze([Buffer.from([255,216])],new AbortController().signal);
 await expect(analyze({observations:['보임']},false)).rejects.toThrow('Incomplete');await expect(analyze(null)).rejects.toThrow('Incomplete');await expect(analyze({observations:[],extra:1})).rejects.toThrow('Invalid');
});

it('extracts near-end samples using actual decodable timestamps from a subsecond recording',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const directory=await mkdtemp(join(tmpdir(),'vision-frame-'));
 try {const bytes=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=160x90:r=5','-t','0.6','-c:v','libvpx','-f','webm','pipe:1'],{windowsHide:true});const filename=join(directory,'media-0.webm');await writeFile(filename,bytes);
 const result=await createConsultationVision(readConfig(),fakeLlm(true)).extractFrames([{filename,size:bytes.length}],[0,599],new AbortController().signal);
 expect(result.frames).toHaveLength(2);expect(result.frameTimesMs.every(time=>time>=0&&time<=400)).toBe(true);expect(result.frames.every(frame=>frame[0]===255&&frame[1]===216)).toBe(true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('rejects persisted complete vision with unfinished scenes or reviewed processing state',async()=>{
 const {visionAnalysisSchema}=await import('../src/domain/consultation-vision.ts');const base={revision:'00000000-0000-4000-8000-000000000001',state:'complete',model:'test',intervalMs:30000,scenes:[{id:'00000000-0000-4000-8000-000000000002',atMs:0,frameTimesMs:[0],state:'pending',observations:[],originalObservations:[]}]};
 expect(visionAnalysisSchema.safeParse(base).success).toBe(false);expect(visionAnalysisSchema.safeParse({...base,state:'processing',reviewedAt:new Date().toISOString()}).success).toBe(false);
});
