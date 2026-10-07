import { afterEach, expect, test, vi } from 'vitest';
import { createConsultation, listConsultations, uploadAudio, uploadMedia, deleteConsultation, recordingUrl, approveConsultation } from './consultation-api';
afterEach(()=>vi.unstubAllGlobals());
test('API uses guarded same-origin JSON and raw ordered uploads', async () => {
  const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({id:'s',sessions:[]})}); vi.stubGlobal('fetch',fetcher);
  await createConsultation({petName:'초코',trainerName:'훈련사',sessionDate:'2026-10-07'}); await listConsultations(); const audio=new Blob(['wav']); await uploadAudio('s',2,audio,10000,20000); await uploadMedia('s',3,new Blob(['webm']));
  expect(fetcher.mock.calls[0][1]).toMatchObject({credentials:'same-origin',method:'POST'}); expect(JSON.parse(fetcher.mock.calls[0][1].body)).toMatchObject({consent:true}); expect(fetcher.mock.calls[2][0]).toBe('/api/consultations/s/audio/2?startMs=10000&endMs=20000'); expect(fetcher.mock.calls[2][1].body).toBe(audio); expect(recordingUrl('s')).toBe('/api/consultations/s/recording');
});
test('delete accepts204 without JSON body',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,status:204})); await expect(deleteConsultation('s')).resolves.toBeUndefined();});
test('approval submits the revision of the persisted note that was reviewed', async () => {
  const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({id:'s'})}); vi.stubGlobal('fetch',fetcher);
  await approveConsultation('s', 'reviewed-revision');
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({reviewed:true,noteRevision:'reviewed-revision'});
});
