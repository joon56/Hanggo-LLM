import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { CallRoom } from './roles/CallRoom';
import { GuardianHome } from './roles/GuardianHome';
import { GuardianJoin } from './roles/GuardianJoin';
import { ReviewRoom } from './roles/ReviewRoom';
import { TrainerHome } from './roles/TrainerHome';
import './styles.css';

const navigate = (path: string) => location.assign(path);
const path = location.pathname;
// Messengers and phone keyboards can change the case of a path or cut a link short. A token is still needed, and the screen says so.
const join = /^\/join(?:\/([^/]*))?$/i.exec(path);
const room = /^\/room\/([^/]+)$/.exec(path)?.[1];
const review = /^\/review\/([^/]+)$/.exec(path)?.[1];

// Call screens own a camera and a signaling socket, so they skip StrictMode's mount-unmount-mount cycle.
const page = join ? <GuardianJoin token={join[1] ?? ''} navigate={navigate} />
  : room ? <CallRoom consultationId={room} navigate={navigate} />
  : review ? <ReviewRoom consultationId={review} navigate={navigate} />
  : path === '/coaching' ? <TrainerHome navigate={navigate} />
  : path === '/guardian' ? <GuardianHome navigate={navigate} />
  : <StrictMode><App /></StrictMode>;

createRoot(document.getElementById('root')!).render(page);
