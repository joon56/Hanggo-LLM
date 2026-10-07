import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, test, vi } from 'vitest';
import ConsultationWorkspace from './ConsultationWorkspace';
import type { ConsultationSession } from '../domain/consultation';
import * as api from '../consultation-api';
import { useConsultationRecorder } from '../hooks/useConsultationRecorder';
import { ApiError } from '../api';

vi.mock('../consultation-api',()=>({startVision:vi.fn(),cancelVision:vi.fn(),updateVisionScene:vi.fn(),reviewVision:vi.fn(),visionFrameUrl:(id:string,scene:string,index:number)=>`/api/consultations/${id}/vision/scenes/${scene}/frames/${index}`,listConsultations:vi.fn(),getConsultation:vi.fn(),finishConsultation:vi.fn(),addBookmark:vi.fn(),updateSegment:vi.fn(),generateConsultationNote:vi.fn(),updateConsultationNote:vi.fn(),approveConsultation:vi.fn(),deleteConsultation:vi.fn(),recordingUrl:(id:string)=>`/api/consultations/${id}/recording`,exportUrl:(id:string)=>`/api/consultations/${id}/export`}));
vi.mock('../hooks/useConsultationRecorder',()=>({useConsultationRecorder:vi.fn()}));
let saved:ConsultationSession;
const recorder={status:'idle',error:'',session:null,durationMs:0,pendingBytes:0,preview:null,busy:false,start:vi.fn(),stop:vi.fn(),retry:vi.fn()};
beforeEach(()=>{
  vi.clearAllMocks(); Object.assign(recorder,{status:'idle',error:'',session:null,durationMs:0,pendingBytes:0,preview:null,busy:false});
  saved={id:'saved-1',metadata:{petName:'초코',trainerName:'훈련사',sessionDate:'2026-10-07'},createdAt:'2026-10-07T01:00:00Z',state:'ready',durationMs:10000,recordingChunkCount:3,segments:[{id:'seg-1',sequence:0,startMs:0,endMs:10000,text:'초코가 앉았습니다.',originalText:'초코가 앉았습니다.',state:'complete',latencyMs:200}],bookmarks:[{id:'b-1',atMs:5000,text:'앉기 연습'}],errors:[],note:{items:[{id:'n-1',section:'observation',text:'초코가 앉았습니다.',evidence:[{kind:'segment',id:'seg-1',quote:'초코가 앉았습니다.',startMs:0,endMs:10000}],fallback:true}],missingSections:['purpose','owner_report','guidance','task','follow_up','moments'],coveredSegmentIds:['seg-1'],createdAt:'2026-10-07T01:00:00Z',fallbackUsed:true,warnings:['분류 결과를 확인해 주세요.']}};
  saved.noteRevision='saved-revision';
  vi.mocked(useConsultationRecorder).mockReturnValue(recorder as never); vi.mocked(api.listConsultations).mockResolvedValue({sessions:[saved]}); vi.mocked(api.getConsultation).mockImplementation(async()=>saved); vi.mocked(api.updateSegment).mockImplementation(async(_id,_segment,text)=>({...saved,note:undefined,segments:[{...saved.segments[0],text}]})); vi.mocked(api.updateConsultationNote).mockImplementation(async(_id,note)=>({...saved,note}));
});
async function open(){await screen.findByRole('button',{name:/초코.*열기/});fireEvent.click(screen.getByRole('button',{name:/초코.*열기/}));await screen.findByRole('textbox',{name:'받아쓰기 1'});}
test('recovers persisted session and uses seekable recording endpoint',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();expect(screen.getByLabelText('상담 녹화 재생')).toHaveAttribute('src','/api/consultations/saved-1/recording');expect(screen.getByRole('link',{name:'JSON 내보내기'})).toHaveAttribute('href','/api/consultations/saved-1/export');});

test('exports retained transcript JSON from an incomplete session without any media', async () => {
  saved={...saved,state:'incomplete',recordingChunkCount:0}; render(<ConsultationWorkspace ready model="whisper-turbo"/>); await open();
  expect(screen.getByRole('link',{name:'JSON 내보내기'})).toHaveAttribute('href','/api/consultations/saved-1/export');
  expect(screen.queryByLabelText('상담 녹화 재생')).not.toBeInTheDocument(); expect(screen.queryByRole('link',{name:'녹화 내려받기'})).not.toBeInTheDocument();
  expect(screen.getByRole('textbox',{name:'받아쓰기 1'})).toHaveValue('초코가 앉았습니다.');
});

test('approval uses reviewed persisted revision and reloads changed notes with review cleared', async () => {
  Object.assign(saved,{noteRevision:'reviewed-revision'}); render(<ConsultationWorkspace ready model="whisper-turbo"/>); await open();
  await waitFor(()=>expect(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})).toBeEnabled());
  const changed=structuredClone(saved); Object.assign(changed,{noteRevision:'new-revision'}); changed.note!.items[0].section='purpose'; changed.note!.missingSections=['owner_report','observation','guidance','task','follow_up','moments'];
  vi.mocked(api.getConsultation).mockResolvedValue(changed); vi.mocked(api.approveConsultation).mockRejectedValueOnce(new ApiError('Note changed after review.','NOTE_CHANGED')).mockResolvedValueOnce({...changed,note:{...changed.note!,approvedAt:'2026-10-07T02:00:00Z'}});
  fireEvent.click(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})); fireEvent.click(screen.getByRole('button',{name:'검토 후 확정'}));
  await waitFor(()=>expect(api.approveConsultation).toHaveBeenCalledWith('saved-1','reviewed-revision'));
  await waitFor(()=>expect(screen.getByRole('combobox',{name:'일지 항목 1 분류'})).toHaveValue('purpose'));
  expect(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})).not.toBeChecked(); expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('다시 검토');
  fireEvent.click(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})); fireEvent.click(screen.getByRole('button',{name:'검토 후 확정'}));
  await waitFor(()=>expect(api.approveConsultation).toHaveBeenLastCalledWith('saved-1','new-revision')); expect(await screen.findByText('검토·확정됨')).toBeInTheDocument();
});
test('requires explicit deletion confirmation before removing persisted session',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByRole('button',{name:'초코 상담 삭제'}));expect(api.deleteConsultation).not.toHaveBeenCalled();vi.mocked(window.confirm).mockReturnValue(true);vi.mocked(api.deleteConsultation).mockResolvedValue();fireEvent.click(screen.getByRole('button',{name:'초코 상담 삭제'}));await waitFor(()=>expect(api.deleteConsultation).toHaveBeenCalledWith('saved-1'));});
test('shows all seven sections, exact evidence and fallback warnings',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();for(const title of ['상담 목적·고민','보호자 보고','상담 중 관찰','훈련사 안내','합의한 과제','후속 확인','중요 장면'])expect(screen.getByRole('heading',{name:title})).toBeInTheDocument();expect(screen.getByText('원문 인용으로 대체한 항목입니다.')).toBeInTheDocument();expect(screen.getByText('분류 결과를 확인해 주세요.')).toBeInTheDocument();expect(screen.getAllByText('분류된 항목 없음 · 원문을 확인해 주세요')).toHaveLength(6);});
test('unsupported note text gives validation feedback and cannot approve',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'일지 항목 1'}),{target:{value:'새 진단을 받았습니다.'}});fireEvent.click(screen.getByRole('button',{name:'일지 수정 저장'}));expect(await screen.findByRole('alert')).toHaveTextContent('원문에 있는 정확한 인용');expect(api.updateConsultationNote).not.toHaveBeenCalled();expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeDisabled();});
test('transcript correction saves source and requires note regeneration',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'받아쓰기 1'}),{target:{value:'초코가 기다렸습니다.'}});fireEvent.click(screen.getByRole('button',{name:'받아쓰기 1 저장'}));await waitFor(()=>expect(api.updateSegment).toHaveBeenCalledWith('saved-1','seg-1','초코가 기다렸습니다.'));expect(screen.queryByRole('textbox',{name:'일지 항목 1'})).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeEnabled();});
test('changing section preserves exact quote and recomputes missing sections',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('combobox',{name:'일지 항목 1 분류'}),{target:{value:'purpose'}});fireEvent.click(screen.getByRole('button',{name:'일지 수정 저장'}));await waitFor(()=>expect(api.updateConsultationNote).toHaveBeenCalled());expect(vi.mocked(api.updateConsultationNote).mock.calls[0][1].items[0].section).toBe('purpose');expect(vi.mocked(api.updateConsultationNote).mock.calls[0][1].missingSections).toContain('observation');});
test('deleting only evidence for transcript shows coverage feedback',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.click(screen.getByRole('button',{name:'일지 항목 1 삭제'}));fireEvent.click(screen.getByRole('button',{name:'일지 수정 저장'}));expect(await screen.findByRole('alert')).toBeInTheDocument();expect(api.updateConsultationNote).not.toHaveBeenCalled();});
test('legacy tab input preserves optional microphone',async()=>{render(<ConsultationWorkspace ready model="whisper-turbo"/>);fireEvent.change(screen.getByRole('combobox',{name:'녹화 입력'}),{target:{value:'tab'}});const start=screen.getByRole('button',{name:'탭 공유·녹화 시작'});expect(start).toBeDisabled();fireEvent.change(screen.getByLabelText('반려동물 이름'),{target:{value:'초코'}});fireEvent.change(screen.getByLabelText('훈련사 이름'),{target:{value:'훈련사'}});fireEvent.click(screen.getByRole('checkbox',{name:/상담 참여자 동의/}));fireEvent.click(screen.getByRole('checkbox',{name:'내 마이크 함께 녹음'}));fireEvent.click(start);expect(recorder.start).toHaveBeenCalledWith(expect.objectContaining({petName:'초코',trainerName:'훈련사'}),true,'tab');});
test('busy callback locks workspace while finishing and recovery notice is truthful',async()=>{Object.assign(recorder,{status:'blocked',busy:true,error:'저장 미완료: 대기 데이터는 이 탭에 남아 있습니다.'});const busy=vi.fn();render(<ConsultationWorkspace ready model="whisper-turbo" onBusyChange={busy}/>);expect(busy).toHaveBeenCalledWith(true);expect(screen.getByRole('button',{name:'저장 재시도'})).toBeEnabled();expect(screen.getByRole('alert')).toHaveTextContent('저장 미완료');});
test('reopened active capture can be finalized incomplete only after confirmation',async()=>{
  saved={...saved,state:'recording',durationMs:0,note:undefined};vi.mocked(api.finishConsultation).mockResolvedValue({...saved,state:'incomplete',durationMs:10000});render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();vi.spyOn(window,'confirm').mockReturnValue(false);fireEvent.click(screen.getByRole('button',{name:'중단된 상담 정리'}));expect(api.finishConsultation).not.toHaveBeenCalled();vi.mocked(window.confirm).mockReturnValue(true);fireEvent.click(screen.getByRole('button',{name:'중단된 상담 정리'}));await waitFor(()=>expect(api.finishConsultation).toHaveBeenCalledWith('saved-1',10000,expect.any(String)));
});
test('starting new capture clears previous source before model preparation',async()=>{
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByLabelText('반려동물 이름'),{target:{value:'새 상담'}});fireEvent.change(screen.getByLabelText('훈련사 이름'),{target:{value:'훈련사'}});fireEvent.click(screen.getByRole('checkbox',{name:/상담 참여자 동의/}));fireEvent.click(screen.getByRole('button',{name:'카메라·마이크 녹화 시작'}));expect(screen.queryByRole('textbox',{name:'받아쓰기 1'})).not.toBeInTheDocument();
});
test('unsaved visible transcript clears review and blocks stale note approval and generation',async()=>{
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();const review=screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/});fireEvent.click(review);expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox',{name:'받아쓰기 1'}),{target:{value:'수정했지만 아직 저장하지 않은 원문'}});expect(review).not.toBeChecked();expect(review).toBeDisabled();expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeDisabled();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();fireEvent.click(screen.getByRole('button',{name:'검토 후 확정'}));expect(api.approveConsultation).not.toHaveBeenCalled();
});
test('explicitly discarding transcript edits restores persisted source and requires fresh review',async()=>{
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.click(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/}));fireEvent.change(screen.getByRole('textbox',{name:'받아쓰기 1'}),{target:{value:'미저장 원문'}});fireEvent.click(screen.getByRole('button',{name:'받아쓰기 1 수정 취소'}));expect(screen.getByRole('textbox',{name:'받아쓰기 1'})).toHaveValue(saved.segments[0].text);expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeEnabled();expect(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})).not.toBeChecked();expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeDisabled();
});
test('saving one transcript cannot clear another unsaved segment',async()=>{
  saved.segments.push({...saved.segments[0],id:'seg-2',sequence:1,startMs:10000,endMs:20000,text:'다음 원문'});saved.durationMs=20000;vi.mocked(api.updateSegment).mockImplementation(async(_id,id,text)=>({...saved,note:undefined,segments:saved.segments.map(segment=>segment.id===id?{...segment,text}:segment)}));render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'받아쓰기 1'}),{target:{value:'첫 원문 수정'}});fireEvent.change(screen.getByRole('textbox',{name:'받아쓰기 2'}),{target:{value:'두 번째 미저장 수정'}});fireEvent.click(screen.getByRole('button',{name:'받아쓰기 1 저장'}));await waitFor(()=>expect(api.updateSegment).toHaveBeenCalled());expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();expect(screen.getByRole('textbox',{name:'받아쓰기 2'})).toHaveValue('두 번째 미저장 수정');
});

function vision(reviewed = false) {
  saved.captureSource = 'camera'; saved.vision = {revision:'vision-r1',state:'complete',model:'qwen3.5:9b',intervalMs:30000,reviewedAt:reviewed?'2026-10-07T02:00:00Z':undefined,scenes:[{id:'scene-1',atMs:1250,frameTimesMs:[1000,1250,2000],state:'complete',observations:['초코가 화면 오른쪽을 봅니다.'],originalObservations:['초코가 화면 오른쪽을 봅니다.']}]};
  saved.note!.items.push({id:'visual-note',section:'observation',text:saved.vision.scenes[0].observations[0],evidence:[{kind:'vision',id:'scene-1',quote:saved.vision.scenes[0].observations[0],startMs:1000,endMs:2000}]});
}
test('default input records camera plus mandatory microphone', async () => {
  render(<ConsultationWorkspace ready model="whisper-turbo"/>); expect(screen.getByRole('combobox',{name:'녹화 입력'})).toHaveValue('camera');
  fireEvent.change(screen.getByLabelText('반려동물 이름'),{target:{value:'초코'}});fireEvent.change(screen.getByLabelText('훈련사 이름'),{target:{value:'훈련사'}});fireEvent.click(screen.getByRole('checkbox',{name:/상담 참여자 동의/}));
  fireEvent.click(screen.getByRole('button',{name:'카메라·마이크 녹화 시작'}));expect(recorder.start).toHaveBeenCalledWith(expect.objectContaining({petName:'초코'}),true,'camera');
});
test('moment pin freezes recording time before typing and saving memo', async () => {
  Object.assign(recorder,{status:'recording',busy:true,durationMs:1234,session:{...saved,state:'recording'}});
  const {rerender}=render(<ConsultationWorkspace ready model="whisper-turbo"/>); await screen.findByRole('button',{name:'현재 장면 표시'});
  fireEvent.click(screen.getByRole('button',{name:'현재 장면 표시'}));expect(screen.getByText('표시한 순간 00:01.234')).toBeInTheDocument();
  recorder.durationMs=9876;rerender(<ConsultationWorkspace ready model="whisper-turbo"/>);fireEvent.change(screen.getByLabelText('순간 메모'),{target:{value:'고개 돌림'}});
  vi.mocked(api.addBookmark).mockResolvedValue(saved);fireEvent.click(screen.getByRole('button',{name:'순간 메모 저장'}));await waitFor(()=>expect(api.addBookmark).toHaveBeenCalledWith('saved-1',1234,'고개 돌림'));
});
test('replay moment pin keeps subsecond currentTime before memo entry', async () => {
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();Object.defineProperty(screen.getByLabelText('상담 녹화 재생'),'currentTime',{configurable:true,writable:true,value:3.456});
  fireEvent.click(screen.getByRole('button',{name:'현재 장면 표시'}));expect(screen.getByLabelText('순간 시각 · 초')).toHaveValue(3.456);fireEvent.change(screen.getByLabelText('순간 메모'),{target:{value:'재생 확인'}});vi.mocked(api.addBookmark).mockResolvedValue(saved);fireEvent.click(screen.getByRole('button',{name:'순간 메모 저장'}));await waitFor(()=>expect(api.addBookmark).toHaveBeenCalledWith('saved-1',3456,'재생 확인'));
});
test('camera notes require complete vision', async () => {
  saved.captureSource='camera'; render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();expect(screen.getByRole('button',{name:'장면 분석 시작'})).toBeEnabled();
});
test('unsaved visual edit clears review and blocks vision review note generation and approval', async () => {
  vision(true);render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.click(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/}));expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox',{name:'장면 1 관찰'}),{target:{value:'미저장 관찰'}});expect(screen.getByRole('button',{name:'장면 관찰 검토 완료'})).toBeDisabled();expect(screen.queryByText('장면 관찰 검토됨')).not.toBeInTheDocument();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeDisabled();expect(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})).not.toBeChecked();
  fireEvent.click(screen.getByRole('button',{name:'장면 1 수정 취소'}));expect(screen.getByRole('button',{name:'장면 관찰 검토 완료'})).toBeEnabled();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();
  vi.mocked(api.reviewVision).mockResolvedValue(saved);fireEvent.click(screen.getByRole('button',{name:'장면 관찰 검토 완료'}));await waitFor(()=>expect(api.reviewVision).toHaveBeenCalledWith('saved-1','vision-r1'));await waitFor(()=>expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeEnabled());
});
test('scene saves empty observations preserving original results and requires new revision review', async () => {
  vision(true); const edited={...saved,vision:{...saved.vision!,revision:'vision-r2',reviewedAt:undefined,scenes:[{...saved.vision!.scenes[0],observations:[]}]},note:undefined};vi.mocked(api.updateVisionScene).mockResolvedValue(edited);
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();expect(screen.getByRole('img',{name:'장면 1 프레임 2 · 00:01.250'})).toHaveAttribute('src','/api/consultations/saved-1/vision/scenes/scene-1/frames/1');
  fireEvent.change(screen.getByRole('textbox',{name:'장면 1 관찰'}),{target:{value:''}});fireEvent.click(screen.getByRole('button',{name:'장면 1 저장'}));await waitFor(()=>expect(api.updateVisionScene).toHaveBeenCalledWith('saved-1','scene-1','vision-r1',[]));expect(screen.getByRole('textbox',{name:'장면 1 관찰'})).toHaveValue('');expect(screen.getByText('최초 AI 관찰')).toBeInTheDocument();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();
});
test('reopened processing analysis shows progress cancel and source editing locks', async () => {
  vision();saved.vision!.state='processing';saved.vision!.scenes[0].state='pending';vi.mocked(api.cancelVision).mockResolvedValue({...saved,vision:{...saved.vision!,state:'cancelled'}});
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();expect(screen.getByRole('progressbar',{name:'장면 분석 진행'})).toHaveAttribute('value','0');expect(screen.getByRole('textbox',{name:'받아쓰기 1'})).toBeDisabled();expect(screen.getByLabelText('순간 메모')).toBeDisabled();expect(screen.getByRole('button',{name:'장면 분석 취소'})).toBeEnabled();fireEvent.click(screen.getByRole('button',{name:'장면 분석 취소'}));await waitFor(()=>expect(api.cancelVision).toHaveBeenCalledWith('saved-1'));await waitFor(()=>expect(screen.getByRole('button',{name:'장면 분석 다시 시도'})).toBeEnabled());
});
test('tab visual evidence also requires explicit vision review for approval', async () => {
  vision();saved.captureSource='tab';
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();expect(screen.getByRole('button',{name:'00:01.000 · 장면 관찰 근거'})).toBeInTheDocument();expect(screen.getByRole('checkbox',{name:/녹화·받아쓰기·모든 일지 항목/})).toBeDisabled();expect(screen.getByRole('button',{name:'검토 후 확정'})).toBeDisabled();
});
test('reopened analysis polls to completion without another click', async () => {
  vision(); const completed=structuredClone(saved); saved.vision!.state='processing'; saved.vision!.scenes[0].state='pending';
  vi.useFakeTimers(); try { render(<ConsultationWorkspace ready model="whisper-turbo"/>); await act(async()=>{}); await act(async()=>fireEvent.click(screen.getByRole('button',{name:/초코.*열기/}))); vi.mocked(api.getConsultation).mockResolvedValue(completed); await act(async()=>vi.advanceTimersByTime(2000)); expect(screen.getByRole('textbox',{name:'장면 1 관찰'})).toBeEnabled();expect(screen.getByRole('button',{name:'장면 관찰 검토 완료'})).toBeEnabled(); } finally { vi.useRealTimers(); }
});
test('saving one scene preserves another unsaved scene and blocks review', async () => {
  vision(true);saved.vision!.scenes.push({...saved.vision!.scenes[0],id:'scene-2',observations:['두 번째 장면'],originalObservations:['두 번째 장면']});
  vi.mocked(api.updateVisionScene).mockImplementation(async(_id,id,_revision,observations)=>({...saved,note:undefined,vision:{...saved.vision!,revision:'r2',reviewedAt:undefined,scenes:saved.vision!.scenes.map(scene=>scene.id===id?{...scene,observations}:scene)}}));
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'장면 1 관찰'}),{target:{value:'첫 장면 수정'}});fireEvent.change(screen.getByRole('textbox',{name:'장면 2 관찰'}),{target:{value:'두 번째 미저장'}});fireEvent.click(screen.getByRole('button',{name:'장면 1 저장'}));await waitFor(()=>expect(api.updateVisionScene).toHaveBeenCalled());expect(screen.getByRole('textbox',{name:'장면 2 관찰'})).toHaveValue('두 번째 미저장');expect(screen.getByRole('button',{name:'장면 관찰 검토 완료'})).toBeDisabled();
});
test('saving whitespace-only edit on empty scene clears visible edit after success', async () => {
  vision();saved.vision!.scenes[0].observations=[];vi.mocked(api.updateVisionScene).mockResolvedValue({...saved,vision:{...saved.vision!,revision:'r2'}});
  render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'장면 1 관찰'}),{target:{value:'  '}});fireEvent.click(screen.getByRole('button',{name:'장면 1 저장'}));await waitFor(()=>expect(api.updateVisionScene).toHaveBeenCalledWith('saved-1','scene-1','vision-r1',[]));await waitFor(()=>expect(screen.getByRole('textbox',{name:'장면 1 관찰'})).toHaveValue(''));expect(screen.queryByRole('button',{name:'장면 1 수정 취소'})).not.toBeInTheDocument();
});
test('unsaved visual scene prevents bookmark mutation discarding its analysis', async () => {
  vision(true);render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'장면 1 관찰'}),{target:{value:'보존할 미저장 관찰'}});fireEvent.change(screen.getByLabelText('순간 메모'),{target:{value:'새 메모'}});expect(screen.getByRole('button',{name:'순간 메모 저장'})).toBeDisabled();
});
test('failed observation save retains edit and all review gates', async () => {
  vision(true);vi.mocked(api.updateVisionScene).mockRejectedValue(new Error('저장 실패'));render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();fireEvent.change(screen.getByRole('textbox',{name:'장면 1 관찰'}),{target:{value:'아직 저장되지 않은 관찰'}});fireEvent.click(screen.getByRole('button',{name:'장면 1 저장'}));expect(await screen.findByRole('alert')).toHaveTextContent('저장 실패');expect(screen.getByRole('textbox',{name:'장면 1 관찰'})).toHaveValue('아직 저장되지 않은 관찰');expect(screen.getByRole('button',{name:'장면 관찰 검토 완료'})).toBeDisabled();expect(screen.getByRole('button',{name:'상담 일지 만들기'})).toBeDisabled();
});
test('pending scene does not request frame images before persistence', async () => {
  vision();saved.vision!.state='processing';saved.vision!.scenes[0].state='pending';render(<ConsultationWorkspace ready model="whisper-turbo"/>);await open();expect(screen.queryAllByRole('img',{name:/장면 1 프레임/})).toHaveLength(0);
});
