import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import App from '../App';

vi.mock('@audiotool/nexus', () => ({
  createAudiotoolClient: vi.fn(),
  getLoginStatus: vi.fn().mockResolvedValue({ loggedIn: false }),
}));

describe('App component', () => {
  it('renders without crashing', () => {
    const { container } = render(<App />);
    expect(container).toBeTruthy();
  });
});
