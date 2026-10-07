// @vitest-environment node
import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { ConsultationStore } from './consultation-store.ts';
import type { VisionService } from './consultation-vision.ts';
import { createConsultationRouter } from './consultation-router.ts';
import { generateConsultationNote } from './consultation-notes.ts';
import { validateConsultationNote } from '../src/domain/consultation.ts';
import { createDraft } from '../src/domain/notes.ts';
const dirs: string[] = [];
const metadata = { petName: 'Choco', trainerName: 'Kim', sessionDate: '2026-10-07' };
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, {recursive:true, force:true}))); });
async function fixture(analyze: (frames: Buffer[], signal: AbortSignal) => Promise<string[]> = async () => ['Dog sits.'], extractFrames?: VisionService['extractFrames']) {
 const dir = await mkdtemp(path.join(os.tmpdir(), 'camera-')); dirs.push(dir);
 const store = new ConsultationStore(dir); const session = await store.create(metadata, 'camera');
 await store.update(session.id, s => { s.state='ready'; s.durationMs=5000; });
 const release = vi.fn(); const acquire = vi.fn(() => release);
 const routes = createConsultationRouter({enabled:true,directory:dir,generate:async text => ({draft:createDraft(text,'trainer_summary_voice')}),acquireAi:acquire,vision:{model:'test',extractFrames:extractFrames ?? (async (_files,times) => ({frames:times.map(() => Buffer.from([0xff,0xd8,0xff,0xd9])),frameTimesMs:times})),analyze}});
 const app = express(); app.use(express.json()); const arrivals=new Map<string,()=>void>(); app.use((req,_res,next)=>{arrivals.get(req.path)?.();next();}); app.use(routes.router); const arrived=(route:string)=>new Promise<void>(resolve=>arrivals.set('/'+session.id+route,resolve));
 const post = (route: string, body = {}) => request(app).post(`/${session.id}${route}`).send(body);
 return {store,session,app,post,release,acquire,dir,arrived,routes};
}
it('persists camera source and rejects notes before complete vision',async () => {
 const f=await fixture(); expect((await new ConsultationStore(f.dir).get(f.session.id)).captureSource).toBe('camera');
 await f.post('/note').expect(409);
});
it('runs persisted vision, preserves exact visual evidence, requires review and invalidates stale revisions',async () => {
 const f=await fixture(); const started=await f.post('/vision').expect(202); expect(started.body.vision.state).toBe('processing');
 let result; for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 expect(result.vision.state).toBe('complete'); expect(f.release).toHaveBeenCalledOnce();
 const generated=await f.post('/note').expect(200); expect(generated.body.note.items[0].evidence[0].kind).toBe('vision');
 expect(validateConsultationNote(generated.body.note,result)).toEqual([]);
 await f.post('/approve',{reviewed:true,noteRevision:generated.body.noteRevision}).expect(409);
 await f.post('/vision/review',{revision:'00000000-0000-4000-8000-000000000000',reviewed:true}).expect(409);
 const reviewed=await f.post('/vision/review',{revision:result.vision.revision,reviewed:true}).expect(200);
 await f.post('/approve',{reviewed:true,noteRevision:generated.body.noteRevision}).expect(200);
 const edited=await request(f.app).patch(`/${f.session.id}/vision/scenes/${result.vision.scenes[0].id}`).send({revision:reviewed.body.vision.revision,observations:['Dog stands.']}).expect(200);
 expect(edited.body.note).toBeUndefined(); expect(edited.body.vision.reviewedAt).toBeUndefined(); expect(edited.body.vision.scenes[0].originalObservations).toEqual(['Dog sits.']);
});
it('cancels jobs before releasing GPU once and keeps recording session',async () => {
 let began!:()=>void; const started=new Promise<void>(r=>began=r);
 const f=await fixture(async (_frames: Buffer[], signal: AbortSignal) => {began();await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return [];});
 await f.post('/vision').expect(202); await started;
 await f.post('/vision/cancel').expect(200); expect(f.release).toHaveBeenCalledOnce();
 expect((await new ConsultationStore(f.dir).get(f.session.id)).vision?.state).toBe('cancelled');
});

it('keeps failed vision visible and rejects camera note generation',async()=>{
 const f=await fixture(async()=>{throw new Error('Missing vision capability.');}); await f.post('/vision').expect(202);
 let result;for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 expect(result.vision.state).toBe('failed');expect(result.vision.scenes[0].error).toBe('Missing vision capability.');await f.post('/note').expect(409);
 expect((await new ConsultationStore(f.dir).get(f.session.id)).vision?.state).toBe('failed');
});
it('deletion aborts vision before removing session and releases reservation exactly once',async()=>{
 let began!:()=>void;const started=new Promise<void>(r=>began=r);
 const f=await fixture(async(_frames,signal)=>{began();await new Promise<void>((_,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));return [];});
 await f.post('/vision').expect(202);await started;await f.post('/vision').expect(409);await request(f.app).delete(`/${f.session.id}`).expect(204);expect(f.release).toHaveBeenCalledOnce();await request(f.app).get(`/${f.session.id}`).expect(404);
});
it('recovers interrupted vision without discarding completed scenes or recording metadata',async()=>{
 const f=await fixture();const revision='00000000-0000-4000-8000-000000000001';
 await f.store.update(f.session.id,s=>{s.vision={revision,state:'processing',model:'test',intervalMs:30000,scenes:[{id:revision,atMs:0,frameTimesMs:[0],state:'pending',observations:[],originalObservations:[]}]};});
 const restored=await new ConsultationStore(f.dir).get(f.session.id);expect(restored.vision?.state).toBe('failed');expect(restored.vision?.scenes[0].state).toBe('failed');expect(restored.captureSource).toBe('camera');expect(restored.state).toBe('ready');
});
it('accepts complete camera analysis with no visual observations and no speech',async()=>{
 const f=await fixture(async()=>[]);await f.post('/vision').expect(202);
 for(let i=0;i<100;i++){const result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 const generated=await f.post('/note').expect(200);expect(generated.body.note.items).toEqual([]);
});
it('bookmark changes invalidate completed vision and reject source edits during vision processing',async()=>{
 const f=await fixture();await f.post('/vision').expect(202);let result;for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 const changed=await f.post('/bookmarks',{atMs:2000,text:'New moment'}).expect(200);expect(changed.body.vision).toBeUndefined();
});
it('serves persisted JPEG after scene edits and persists decoded evidence times',async()=>{
 const f=await fixture();await f.post('/vision').expect(202);let result;for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 const scene=result.vision.scenes[0];await request(f.app).get(`/${f.session.id}/vision/scenes/${scene.id}/frames/0`).expect('Content-Type',/image\/jpeg/).expect(200);
 await request(f.app).patch(`/${f.session.id}/vision/scenes/${scene.id}`).send({revision:result.vision.revision,observations:[]}).expect(200);
 await request(f.app).get(`/${f.session.id}/vision/scenes/${scene.id}/frames/0`).expect(200);await request(f.app).get(`/${f.session.id}/vision/scenes/${scene.id}/frames/99`).expect(404);
});
it('rejects visual note evidence omission and invented substrings',async()=>{
 const f=await fixture();await f.post('/vision').expect(202);let result;for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 const note=await generateConsultationNote(result,async text=>({draft:createDraft(text,'trainer_summary_voice')}));result.bookmarks=[{id:'b',atMs:0,text:'Bookmark'}];note.items=[{id:'item',section:'moments',text:'Bookmark',evidence:[{kind:'bookmark',id:'b',quote:'Bookmark',startMs:0,endMs:0}]}];note.missingSections=['purpose','owner_report','observation','guidance','task','follow_up'];expect(validateConsultationNote(note,result)).toContain('VISION_COVERAGE');
});
it('rejects JPEG storage when recording chunks exhaust existing session byte budget',async()=>{
 const f=await fixture();const {readFile,writeFile}=await import('node:fs/promises');const file=path.join(f.dir,f.session.id,'session.json');const persisted=JSON.parse(await readFile(file,'utf8'));persisted.chunks.media=Array.from({length:128},()=>({hash:'0'.repeat(64),size:16*1024**2}));persisted.recordingChunkCount=128;await writeFile(file,JSON.stringify(persisted));
 await f.post('/vision').expect(202);let result;for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 expect(result.vision.state).toBe('failed');expect(result.vision.scenes[0].error).toContain('Session storage budget exceeded');expect(result.recordingChunkCount).toBe(128);
});
async function pauseVisionStartup() {
 const originalUpdate=ConsultationStore.prototype.update;
 const originalGet=ConsultationStore.prototype.get;
 let entered!:()=>void,unpause!:()=>void,paused=false;
 const enteredPromise=new Promise<void>(resolve=>entered=resolve);
 const gate=new Promise<void>(resolve=>unpause=resolve);
 vi.spyOn(ConsultationStore.prototype,'update').mockImplementation(async function(this: ConsultationStore,id,change){
  const probe=await originalGet.call(this,id);change(probe);
  if(!paused&&probe.vision?.state==='processing'){paused=true;entered();await gate;}
  return originalUpdate.call(this,id,change);
 });
 return {entered:enteredPromise,unpause};
}
it('requires review of visual evidence in tab notes while leaving legacy tab notes usable',async()=>{
 const f=await fixture();await f.store.update(f.session.id,s=>{s.captureSource='tab';});await f.post('/vision').expect(202);
 let result;for(let i=0;i<100;i++){result=(await request(f.app).get(`/${f.session.id}`)).body;if(result.vision.state!=='processing')break;}
 const generated=await f.post('/note').expect(200);await f.post('/approve',{reviewed:true,noteRevision:generated.body.noteRevision}).expect(409);
 await f.post('/vision/review',{revision:result.vision.revision,reviewed:true}).expect(200);await f.post('/approve',{reviewed:true,noteRevision:generated.body.noteRevision}).expect(200);
});
it('serializes bookmark mutation against vision startup snapshot',async()=>{
 let finish!:()=>void;const analyzeGate=new Promise<void>(resolve=>finish=resolve);
 const f=await fixture(async()=>{await analyzeGate;return [];});const pause=await pauseVisionStartup();
 const startup=f.post('/vision').then(response=>response);await pause.entered;
 const arrival=f.arrived('/bookmarks');const bookmark=f.post('/bookmarks',{atMs:2000,text:'Racing bookmark'}).then(response=>response);
 // Ensure the competing HTTP request reaches router while startup is paused.
 await arrival;pause.unpause();await startup;
 const edited=await bookmark;finish();await f.post('/vision/cancel');vi.restoreAllMocks();
 expect(edited.status).toBe(409);expect(edited.body.code).toBe('STATE');
});
it('cancellation racing startup waits for registered job and cancels it',async()=>{
 const f=await fixture(async(_frames,signal)=>{await new Promise<void>((_,reject)=>{if(signal.aborted){reject(new Error('aborted'));return;}signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return [];});
 const pause=await pauseVisionStartup();const startup=f.post('/vision').then(response=>response);await pause.entered;
 const arrival=f.arrived('/vision/cancel');const cancellation=f.post('/vision/cancel').then(response=>response);await arrival;pause.unpause();await startup;
 const cancelled=await cancellation;await f.post('/vision/cancel');vi.restoreAllMocks();expect(cancelled.body.vision?.state).toBe('cancelled');expect(f.release).toHaveBeenCalledOnce();
});
async function failTerminalVisionWrites(count: number) {
 const originalUpdate=ConsultationStore.prototype.update;const originalGet=ConsultationStore.prototype.get;let failures=0;
 vi.spyOn(ConsultationStore.prototype,'update').mockImplementation(async function(this:ConsultationStore,id,change){const current=await originalGet.call(this,id);const changed=structuredClone(current);change(changed);
  if(current.vision?.state==='processing'&&changed.vision?.state!=='processing'&&failures<count){failures++;throw Object.assign(new Error('Injected terminal EIO'),{code:'EIO'});}
  return originalUpdate.call(this,id,change);
 });return {failures:()=>failures};
}
async function waitingVisionFixture() {
 let began!:()=>void;const entered=new Promise<void>(resolve=>began=resolve);
 let analyzed=0;const f=await fixture(async(_frames,signal)=>{if(++analyzed===1)return ['Completed visible scene.'];began();await new Promise<void>((_,reject)=>{if(signal.aborted){reject(new Error('aborted'));return;}signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return [];});
 await f.store.update(f.session.id,s=>{s.bookmarks.push({id:'preserved-moment',atMs:2000,text:'Preserved bookmark'});});await f.store.putChunk(f.session.id,'media',0,Buffer.from([0x1a,0x45,0xdf,0xa3,1]));
 await f.post('/vision').expect(202);await entered;return f;
}
it('retries one transient terminal EIO on cancellation and releases GPU once',async()=>{
 const f=await waitingVisionFixture();const injection=await failTerminalVisionWrites(1);
 const cancelled=await f.post('/vision/cancel').expect(200);vi.restoreAllMocks();expect(cancelled.body.vision.state).toBe('cancelled');expect(cancelled.body.vision.scenes[0].observations).toEqual(['Completed visible scene.']);expect(cancelled.body.recordingChunkCount).toBe(1);expect(await f.store.recording(f.session.id)).toEqual(Buffer.from([0x1a,0x45,0xdf,0xa3,1]));expect(injection.failures()).toBe(1);expect(f.release).toHaveBeenCalledOnce();
 await f.post('/vision').expect(202);await f.post('/vision/cancel').expect(200);expect(f.release).toHaveBeenCalledTimes(2);
});
it('reports repeated terminal save failures then repairs orphan processing on later cancellation',async()=>{
 const f=await waitingVisionFixture();const injection=await failTerminalVisionWrites(20);
 const failed=await f.post('/vision/cancel');const orphan=(await request(f.app).get(`/${f.session.id}`)).body;vi.restoreAllMocks();
 const repaired=await f.post('/vision/cancel').expect(200);expect(failed.status).toBe(500);expect(failed.body.code).toBe('STORAGE');expect(orphan.vision.state).toBe('processing');expect(injection.failures()).toBe(2);expect(repaired.body.vision.state).toBe('cancelled');expect(repaired.body.vision.scenes[0].observations).toEqual(['Completed visible scene.']);expect(repaired.body.recordingChunkCount).toBe(1);expect(repaired.body.vision.error).toContain('interrupted');expect(f.release).toHaveBeenCalledOnce();
});
it('orphan cancellation never overwrites a newer analysis revision',async()=>{
 const f=await waitingVisionFixture();await failTerminalVisionWrites(20);await f.post('/vision/cancel');vi.restoreAllMocks();
 const originalUpdate=ConsultationStore.prototype.update;const originalGet=ConsultationStore.prototype.get;let swapped=false;
 vi.spyOn(ConsultationStore.prototype,'update').mockImplementation(async function(this:ConsultationStore,id,change){const current=await originalGet.call(this,id);if(!swapped&&current.vision?.state==='processing'){swapped=true;await originalUpdate.call(this,id,s=>{s.vision!.revision='00000000-0000-4000-8000-000000000001';});}return originalUpdate.call(this,id,change);});
 const cancelled=await f.post('/vision/cancel');vi.restoreAllMocks();const current=(await request(f.app).get(`/${f.session.id}`)).body;
 expect(swapped).toBe(true);expect(cancelled.status).toBe(409);expect(current.vision.revision).toBe('00000000-0000-4000-8000-000000000001');expect(current.vision.state).toBe('processing');await f.post('/vision/cancel').expect(200);
});

it('handles failed terminal background persistence without unhandled rejection and exposes recoverable storage error',async()=>{
 const f=await fixture();const injection=await failTerminalVisionWrites(20);await f.post('/vision').expect(202);
 for(let attempt=0;attempt<100&&!f.release.mock.calls.length;attempt++)await request(f.app).get('/'+f.session.id);
 expect(f.release).toHaveBeenCalledOnce();expect(injection.failures()).toBe(2);const cancelled=await f.post('/vision/cancel');vi.restoreAllMocks();expect(cancelled.status).toBe(500);expect(cancelled.body.code).toBe('STORAGE');expect(injection.failures()).toBe(4);const repaired=await f.post('/vision/cancel').expect(200);expect(repaired.body.vision.state).toBe('cancelled');expect(repaired.body.vision.scenes[0].observations).toEqual(['Dog sits.']);
});
async function completedVision(f: Awaited<ReturnType<typeof fixture>>) {
 await f.post('/vision').expect(202);
 for(let i=0;i<100;i++){const current=(await request(f.app).get('/'+f.session.id)).body;if(current.vision.state!=='processing')return current;}
 throw new Error('Vision did not settle');
}
it('preserves approved source images when replacement startup save fails',async()=>{
 const f=await fixture();const current=await completedVision(f);
 await f.post('/vision/review',{revision:current.vision.revision,reviewed:true}).expect(200);
 const note=await f.post('/note').expect(200);await f.post('/approve',{reviewed:true,noteRevision:note.body.noteRevision}).expect(200);
 const before=(await request(f.app).get('/'+f.session.id)).body;
 await request(f.app).get(`/${f.session.id}/vision/scenes/${current.vision.scenes[0].id}/frames/0`).expect(200);
 vi.spyOn(ConsultationStore.prototype,'update').mockRejectedValueOnce(Object.assign(new Error('Injected startup EIO'),{code:'EIO'}));
 await f.post('/vision').expect(500);vi.restoreAllMocks();
 expect((await request(f.app).get('/'+f.session.id)).body).toEqual(before);
 await request(f.app).get(`/${f.session.id}/vision/scenes/${current.vision.scenes[0].id}/frames/0`).expect(200);
 expect(f.release).toHaveBeenCalledTimes(3);
});
it('persists failed replacement when old frame cleanup fails and permits retry',async()=>{
 const f=await fixture();await completedVision(f);await f.post('/note').expect(200);const {writeFile}=await import('node:fs/promises');
 const folder=path.join(f.dir,f.session.id,'vision');await rm(folder,{recursive:true});await writeFile(folder,'blocked cleanup');
 await f.post('/vision').expect(202);
 for(let i=0;i<100&&f.release.mock.calls.length<3;i++)await request(f.app).get('/'+f.session.id);
 const failed=(await request(f.app).get('/'+f.session.id)).body;
 expect(failed.vision.state).toBe('failed');expect(failed.vision.error).toContain('Unsafe vision directory');expect(failed.note).toBeUndefined();expect(f.release).toHaveBeenCalledTimes(3);
 await rm(folder);const recovered=await completedVision(f);expect(recovered.vision.state).toBe('complete');expect(f.release).toHaveBeenCalledTimes(4);
});
it('shutdown awaits aborted background vision, preserves media and releases once',async()=>{
 const f=await waitingVisionFixture();const first=f.routes.shutdown();expect(f.routes.shutdown()).toBe(first);await first;
 expect((await new ConsultationStore(f.dir).get(f.session.id)).vision?.state).toBe('cancelled');
 expect(await f.store.recording(f.session.id)).toEqual(Buffer.from([0x1a,0x45,0xdf,0xa3,1]));expect(f.release).toHaveBeenCalledOnce();await f.post('/vision').expect(503);
});
it('shutdown racing startup awaits registration then cancels job',async()=>{
 const f=await fixture(async(_frames,signal)=>{await new Promise<void>((_,reject)=>{if(signal.aborted){reject(new Error('aborted'));return;}signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});});return [];});
 const pause=await pauseVisionStartup();const startup=f.post('/vision').then(response=>response);await pause.entered;
 let settled=false;const shutdown=f.routes.shutdown().then(()=>{settled=true;});await Promise.resolve();expect(settled).toBe(false);pause.unpause();await startup;await shutdown;vi.restoreAllMocks();
 expect((await new ConsultationStore(f.dir).get(f.session.id)).vision?.state).toBe('cancelled');expect(f.release).toHaveBeenCalledOnce();
});
it('rejects note startup that resumes after shutdown has settled',async()=>{
 const f=await fixture();await completedVision(f);const original=ConsultationStore.prototype.get;
 let entered!:()=>void,resume!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);const gate=new Promise<void>(resolve=>resume=resolve);
 vi.spyOn(ConsultationStore.prototype,'get').mockImplementationOnce(async function(this:ConsultationStore,id){const session=await original.call(this,id);entered();await gate;return session;});
 const note=f.post('/note').then(response=>response);await began;await f.routes.shutdown();resume();const response=await note;vi.restoreAllMocks();expect(response.status).toBe(503);expect(f.release).toHaveBeenCalledOnce();
});
it('shutdown waits extraction cancellation settlement before releasing AI',async()=>{
 let entered!:()=>void,aborted!:()=>void,settle!:()=>void;const began=new Promise<void>(resolve=>entered=resolve);const cancellation=new Promise<void>(resolve=>aborted=resolve);const gate=new Promise<void>(resolve=>settle=resolve);
 const f=await fixture(undefined,async(_files,_times,signal)=>{entered();await new Promise<void>(resolve=>{if(signal.aborted){resolve();return;}signal.addEventListener('abort',()=>resolve(),{once:true});});aborted();await gate;throw new Error('Extraction aborted');});
 await f.post('/vision').expect(202);await began;let finished=false;const shutdown=f.routes.shutdown().then(()=>{finished=true;});await cancellation;expect(finished).toBe(false);expect(f.release).not.toHaveBeenCalled();
 settle();await shutdown;expect(f.release).toHaveBeenCalledOnce();expect((await new ConsultationStore(f.dir).get(f.session.id)).vision?.state).toBe('cancelled');
});
