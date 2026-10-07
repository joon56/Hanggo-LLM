import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import App from './App';
const api=vi.hoisted(()=>({getSession:vi.fn(),request:vi.fn(async()=>({lessons:[]})),login:vi.fn(),logout:vi.fn(),generateNote:vi.fn(),transcribe:vi.fn(),verifyAudibleAudio:vi.fn()}));
vi.mock('./api',()=>api);
vi.mock('./components/ConsultationWorkspace',()=>({default:({onBusyChange}:{onBusyChange:(busy:boolean)=>void})=><button onClick={()=>onBusyChange(true)}>테스트 녹화 시작</button>}));
const session={authenticated:true,requirePassword:false,aiEnabled:true,configured:true,textModel:'test',sttModel:'test',liveConsultation:{enabled:true,ready:true,model:'whisper-turbo'}};
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();api.getSession.mockResolvedValue(session);});
afterEach(()=>vi.unstubAllEnvs());
test('local enabled session reveals consultation navigation and capture locks workspace switching',async()=>{render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'실시간 상담'}));fireEvent.click(screen.getByRole('button',{name:'테스트 녹화 시작'}));expect(screen.getByRole('button',{name:/^상담일지$/})).toBeDisabled();});
test('disabled live feature does not appear in navigation',async()=>{api.getSession.mockResolvedValue({...session,liveConsultation:{...session.liveConsultation,enabled:false}});render(<App/>);await screen.findByRole('button',{name:'예시 불러오기'});expect(screen.queryByRole('button',{name:'실시간 상담'})).not.toBeInTheDocument();});
test('static public demo never exposes consultation capture',async()=>{vi.stubEnv('VITE_PUBLIC_DEMO','true');render(<App/>);await screen.findByRole('button',{name:'예시 불러오기'});expect(screen.queryByRole('button',{name:'실시간 상담'})).not.toBeInTheDocument();expect(api.getSession).not.toHaveBeenCalled();});
test('capture locks logout until final uploads finish',async()=>{api.getSession.mockResolvedValue({...session,requirePassword:true});render(<App/>);fireEvent.click(await screen.findByRole('button',{name:'실시간 상담'}));fireEvent.click(screen.getByRole('button',{name:'테스트 녹화 시작'}));expect(screen.getByRole('button',{name:'로그아웃'})).toBeDisabled();});
test('active consultation connection status matches live model and ordinary workspace keeps its model',async()=>{
  api.getSession.mockResolvedValue({...session,sttModel:'medium-cpu',statusMessage:'medium CPU 상태'});render(<App/>);await screen.findByText('medium CPU 상태');fireEvent.click(screen.getByRole('button',{name:'실시간 상담'}));expect(screen.getByText('텍스트 test · 음성 whisper-turbo')).toBeInTheDocument();expect(screen.queryByText('medium CPU 상태')).not.toBeInTheDocument();fireEvent.click(screen.getByRole('button',{name:/^상담일지$/}));expect(screen.getByText('텍스트 test · 음성 medium-cpu')).toBeInTheDocument();expect(screen.getByText('medium CPU 상태')).toBeInTheDocument();
});
