import type { MissingDevice } from '../call/devices';

const LABELS = { camera: '카메라', microphone: '마이크' } as const;

export function deviceAdvice({ device, reason }: MissingDevice) {
  const label = LABELS[device];
  switch (reason) {
    case 'denied': return `${label} 권한이 막혀 있습니다. 주소창의 사이트 권한에서 허용한 뒤 새로고침해 주세요.`;
    case 'not-found': return device === 'camera' ? '카메라를 찾지 못했습니다. 음성으로 입장할 수 있습니다.' : '마이크를 찾지 못했습니다. 상대의 말을 듣고 화면을 볼 수 있습니다.';
    case 'busy': return `${label}를 다른 앱이 쓰고 있습니다. 그 앱을 닫고 새로고침해 주세요.`;
    case 'unsupported': return `이 브라우저에서는 ${label}를 쓸 수 없습니다. Chrome이나 Safari로 열어 주세요.`;
    default: return `${label}를 열지 못했습니다. 연결을 확인하고 새로고침해 주세요.`;
  }
}

const IN_APP_BROWSERS = /KAKAOTALK|NAVER\(inapp|Instagram|FBAN|FBAV|Line\/|DaumApps|everytimeApp/i;
/** Messenger browsers often block camera access, so the invite must be opened elsewhere before it is spent. */
export const isInAppBrowser = (userAgent: string) => IN_APP_BROWSERS.test(userAgent);

export function apiMessage(error: unknown, fallback: string) {
  const code = (error as { code?: string })?.code;
  if (code === 'ACTIVE_CONSULTATION') return '진행 중인 상담이 있습니다. 먼저 그 상담을 종료해 주세요.';
  if (code === 'INVITE') return '이 링크는 이미 쓰였거나 만료되었습니다. 훈련사에게 새 링크를 요청해 주세요.';
  if (code === 'AUTH') return '로그인이 필요합니다.';
  return error instanceof Error && error.message ? error.message : fallback;
}
