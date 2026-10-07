// @vitest-environment node
import { expect,it,vi,afterEach } from 'vitest';
import { visionSceneTimes,visionFrameTimes } from '../src/domain/consultation-vision.ts';
import { createConsultationVision } from './consultation-vision.ts';
import { readConfig } from './config.ts';
afterEach(()=>vi.unstubAllGlobals());
it('samples every 30 seconds and bookmarks within 240 scenes and never samples past duration',()=>{
 expect(visionSceneTimes(60001,[{atMs:1234}])).toEqual([0,1234,30000,60000]);expect(()=>visionSceneTimes(3600000,Array.from({length:150},(_,i)=>({atMs:i*1000+1})))).toThrow();expect(visionFrameTimes(0,100)).toEqual([0,99]);expect(()=>visionSceneTimes(3600000,Array.from({length:241},(_,i)=>({atMs:i})))).toThrow();
});
it('checks local model metadata and vision capability before sending images',async()=>{
 const calls:string[]=[];vi.stubGlobal('fetch',async(url:string)=>{calls.push(url);if(url.endsWith('/api/version'))return Response.json({version:'0.35.1'});return Response.json({details:{format:'gguf'},capabilities:['completion']});});
 await expect(createConsultationVision(readConfig()).analyze([Buffer.from([255,216])],new AbortController().signal)).rejects.toThrow('does not support vision');expect(calls.some(url=>url.endsWith('/api/chat'))).toBe(false);
});
it('sends only images to loopback guarded model and preserves empty observation output',async()=>{
 let body:any;vi.stubGlobal('fetch',async(url:string,input:any)=>{if(url.endsWith('/api/version'))return Response.json({version:'0.35.1'});if(url.endsWith('/api/show'))return Response.json({details:{format:'gguf'},capabilities:['completion','vision']});body=JSON.parse(input.body);return Response.json({done:true,done_reason:'stop',message:{content:'{"observations":[]}'}});});
 expect(await createConsultationVision(readConfig()).analyze([Buffer.from([255,216])],new AbortController().signal)).toEqual([]);expect(body.messages[1].images).toEqual(['/9g=']);expect(body.options.num_ctx).toBe(4096);expect(body.keep_alive).toBe('5m');
});

it('extracts near-end samples using actual decodable timestamps from a subsecond recording',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {execFileSync}=await import('node:child_process');
 const directory=await mkdtemp(join(tmpdir(),'vision-frame-'));
 try {const bytes=execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','color=red:s=160x90:r=5','-t','0.6','-c:v','libvpx','-f','webm','pipe:1'],{windowsHide:true});const filename=join(directory,'media-0.webm');await writeFile(filename,bytes);
 const result=await createConsultationVision(readConfig()).extractFrames([{filename,size:bytes.length}],[0,599],new AbortController().signal);
 expect(result.frames).toHaveLength(2);expect(result.frameTimesMs.every(time=>time>=0&&time<=400)).toBe(true);expect(result.frames.every(frame=>frame[0]===255&&frame[1]===216)).toBe(true);
 }finally{await rm(directory,{recursive:true,force:true});}
});
it('rejects persisted complete vision with unfinished scenes or reviewed processing state',async()=>{
 const {visionAnalysisSchema}=await import('../src/domain/consultation-vision.ts');const base={revision:'00000000-0000-4000-8000-000000000001',state:'complete',model:'test',intervalMs:30000,scenes:[{id:'00000000-0000-4000-8000-000000000002',atMs:0,frameTimesMs:[0],state:'pending',observations:[],originalObservations:[]}]};
 expect(visionAnalysisSchema.safeParse(base).success).toBe(false);expect(visionAnalysisSchema.safeParse({...base,state:'processing',reviewedAt:new Date().toISOString()}).success).toBe(false);
});
