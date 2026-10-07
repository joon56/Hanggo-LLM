import { z } from 'zod';
export type CaptureSource = 'camera' | 'tab';
export type VisionScene = { id: string; atMs: number; frameTimesMs: number[]; state: 'pending' | 'complete' | 'failed'; observations: string[]; originalObservations: string[]; error?: string };
export type VisionAnalysis = { revision: string; state: 'processing' | 'complete' | 'failed' | 'cancelled'; model: string; intervalMs: number; scenes: VisionScene[]; reviewedAt?: string; error?: string };
export const VISION_INTERVAL_MS = 30000;
export const MAX_VISION_SCENES = 240;
const time = z.number().int().min(0).max(3600000);
export const visionObservationsSchema = z.array(z.string().trim().min(1).max(500)).max(12);
export const visionAnalysisSchema = z.object({ revision: z.uuid(), state: z.enum(['processing','complete','failed','cancelled']), model: z.string().min(1).max(500), intervalMs: z.literal(VISION_INTERVAL_MS), scenes: z.array(z.object({ id:z.uuid(),atMs:time,frameTimesMs:z.array(time).min(1).max(3),state:z.enum(['pending','complete','failed']),observations:visionObservationsSchema,originalObservations:visionObservationsSchema,error:z.string().max(500).optional() })).min(1).max(MAX_VISION_SCENES), reviewedAt:z.string().datetime().optional(),error:z.string().max(500).optional() }).refine(analysis => (analysis.state !== 'complete' || analysis.scenes.every(scene => scene.state === 'complete')) && (!analysis.reviewedAt || analysis.state === 'complete') && new Set(analysis.scenes.map(scene => scene.id)).size === analysis.scenes.length);
// Every periodic sample and bookmark must fit; never silently omit evidence.
export function visionSceneTimes(durationMs: number, bookmarks: {atMs:number}[]): number[] {
 const bookmarked = [...new Set(bookmarks.map(b=>b.atMs).filter(t=>t>=0 && t<durationMs))].sort((a,b)=>a-b);
 if(bookmarked.length>MAX_VISION_SCENES) throw new Error('Too many bookmarks for bounded vision analysis.');
 const times=new Set(bookmarked); for(let t=0;t<durationMs;t+=VISION_INTERVAL_MS) times.add(t);
 if(times.size>MAX_VISION_SCENES) throw new Error('Too many scenes for bounded vision analysis.');
 return [...times].sort((a,b)=>a-b);
}
export function visionFrameTimes(atMs:number,durationMs:number):number[] { return [...new Set([Math.max(0,atMs-1000),atMs,Math.min(durationMs-1,atMs+1000)])]; }
