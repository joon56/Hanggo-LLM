import { render, screen } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import ConnectionPanel from './ConnectionPanel';

const session = { authenticated: true, requirePassword: false, aiEnabled: true, configured: true, textModel: 'gemini-3.8-flash', sttModel: 'ggml-medium-q5_0.bin (CPU)' };
test.each([['api', '외부 AI 연결됨'], ['ollama', '로컬 AI 연결됨']] as const)('shows the %s connection label', (provider, label) => {
  render(<ConnectionPanel session={{ ...session, provider }} loading={false} error="" onRetry={vi.fn()} onLogin={vi.fn()} onLogout={vi.fn()} localDemo={false} onDemo={vi.fn()} />);
  expect(screen.getByText(label)).toBeInTheDocument();
});
