import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import App from '../App';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockLogin = vi.fn();
const mockLogout = vi.fn();
const createMockAuthenticatedClient = (overrides: Record<string, unknown> = {}) => ({
  status: 'authenticated' as const,
  userName: 'TestUser',
  login: mockLogin,
  logout: mockLogout,
  exportTokens: vi.fn().mockReturnValue({
    accessToken: 'exported-access-token',
    refreshToken: 'exported-refresh-token',
    expiresAt: 1234567890000,
  }),
  projects: {
    listProjects: vi.fn().mockResolvedValue({ projects: [], nextPageToken: '' }),
    createProject: vi.fn().mockResolvedValue({
      project: { name: 'projects/new-123', displayName: 'New Project' },
    }),
    updateProject: vi.fn().mockResolvedValue({}),
    deleteProject: vi.fn().mockResolvedValue({}),
  },
  open: vi.fn().mockResolvedValue({
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  }),
  ...overrides,
});

const createMockUnauthenticatedClient = () => ({
  status: 'unauthenticated' as const,
  login: mockLogin,
  logout: mockLogout,
});

vi.mock('@audiotool/nexus', () => ({
  audiotool: vi.fn().mockResolvedValue({ status: 'unauthenticated' }),
}));

vi.mock('../api', () => ({
  getApiBaseUrl: vi.fn(() => 'http://127.0.0.1:8000'),
  runAgent: vi.fn().mockResolvedValue({ reply: 'Hello from the agent!' }),
  cancelAgentRun: vi.fn().mockResolvedValue(undefined),
  runAgentStream: vi.fn().mockImplementation(
    async (_baseUrl: string, _payload: any, onEvent: (e: any) => void, _opts?: unknown) => {
      onEvent({ type: 'reply', data: { reply: 'Hello from the agent!' } });
    },
  ),
}));

vi.mock('../audiotool/importGeneratedAudio', () => ({
  importAudioBlobToProject: vi.fn().mockResolvedValue(undefined),
}));

// Helpers ----------------------------------------------------------------

/** Import the mocked modules so we can adjust return values per-test. */
const getAudiotoolMock = async () => await import('@audiotool/nexus');
const getApiMock = async () => await import('../api');

/**
 * Configure audiotool() to return an authenticated client on the next call.
 * Returns the mock status object so tests can assert on login/logout calls.
 */
const setupLoggedIn = async () => {
  const { audiotool } = await getAudiotoolMock();
  const status = createMockAuthenticatedClient();
  (audiotool as ReturnType<typeof vi.fn>).mockResolvedValue(status);
  return status;
};

const setupLoggedOut = async () => {
  const { audiotool } = await getAudiotoolMock();
  const status = createMockUnauthenticatedClient();
  (audiotool as ReturnType<typeof vi.fn>).mockResolvedValue(status);
  return status;
};

/** Click the tutorial "Skip" button to dismiss the overlay. */
const dismissTutorial = () => {
  const skip = screen.queryByRole('button', { name: 'Skip' });
  if (skip) {
    fireEvent.click(skip);
  }
};

/** Open the settings sidebar by clicking the cogwheel. */
const openSettings = () => {
  const cogwheel = screen.getByLabelText('Toggle settings');
  fireEvent.click(cogwheel);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('App component', () => {
  beforeEach(() => {
    localStorage.clear();
    // Reset DOM attributes that effects set
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-reduce-motion');
    document.documentElement.removeAttribute('data-high-contrast');
    document.documentElement.removeAttribute('data-color-theme');
    document.documentElement.style.fontSize = '';
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-hover');
    document.documentElement.style.removeProperty('--message-gap');
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ---- Smoke test --------------------------------------------------------

  it('renders without crashing', () => {
    const { container } = render(<App />);
    expect(container).toBeTruthy();
  });

  // ---- Authentication ----------------------------------------------------

  describe('Authentication', () => {
    it('shows "Logged out" status by default', () => {
      render(<App />);
      dismissTutorial();
      expect(screen.getByText('Logged out')).toBeTruthy();
    });

    it('shows Login button when not logged in', () => {
      render(<App />);
      dismissTutorial();
      expect(screen.getByText('Login')).toBeTruthy();
    });

    it('shows "Logged in" and username after successful login check', async () => {
      await setupLoggedIn();
      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      // Click the Check button to trigger login status check
      const checkBtn = screen.getByText('Check');
      await act(async () => {
        fireEvent.click(checkBtn);
      });

      await waitFor(() => {
        expect(screen.getByText('Logged in')).toBeTruthy();
      });
      await waitFor(() => {
        expect(screen.getByText('TestUser')).toBeTruthy();
      });
    });

    it('shows Logout button once logged in', async () => {
      await setupLoggedIn();
      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      const checkBtn = screen.getByText('Check');
      await act(async () => {
        fireEvent.click(checkBtn);
      });

      await waitFor(() => {
        expect(screen.getByText('Logout')).toBeTruthy();
      });
    });
  });

  // ---- Project Management ------------------------------------------------

  describe('Project Management', () => {
    it('shows "New Project" button', () => {
      render(<App />);
      dismissTutorial();
      expect(screen.getByText('New Project')).toBeTruthy();
    });

    it('disables "New Project" button when not logged in', () => {
      render(<App />);
      dismissTutorial();
      const btn = screen.getByText('New Project') as HTMLButtonElement;
      expect(btn.disabled).toBe(true);
    });

    it('shows "Project idle" status in the sidebar footer by default', () => {
      render(<App />);
      dismissTutorial();
      expect(screen.getByText('Project idle')).toBeTruthy();
    });

    it('shows project connection hint when no project is connected', () => {
      render(<App />);
      dismissTutorial();
      expect(screen.getByText('Connect a project in the sidebar to get started.')).toBeTruthy();
    });

    it('shows project list heading when logged in', async () => {
      await setupLoggedIn();
      const { audiotool } = await getAudiotoolMock();

      // Mock list returning one project
      (audiotool as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockAuthenticatedClient({
          projects: {
            listProjects: vi.fn().mockResolvedValue({
              projects: [{ name: 'projects/abc', displayName: 'My Song' }],
              nextPageToken: '',
            }),
            createProject: vi.fn(),
            updateProject: vi.fn().mockResolvedValue({}),
            deleteProject: vi.fn().mockResolvedValue({}),
          },
        }),
      );

      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByText('Projects')).toBeTruthy();
      });

      await waitFor(() => {
        expect(screen.getByText('My Song')).toBeTruthy();
      });

      expect(screen.getByText('Connect by URL')).toBeTruthy();
      expect(screen.getByLabelText('Audiotool project URL')).toBeTruthy();
    });

    it('filters projects by search query', async () => {
      await setupLoggedIn();
      const { audiotool } = await getAudiotoolMock();

      (audiotool as ReturnType<typeof vi.fn>).mockResolvedValue(
        createMockAuthenticatedClient({
          projects: {
            listProjects: vi.fn().mockResolvedValue({
              projects: [
                { name: 'projects/abc', displayName: 'My Song' },
                { name: 'projects/def', displayName: 'Other Beat' },
              ],
              nextPageToken: '',
            }),
            createProject: vi.fn(),
            updateProject: vi.fn().mockResolvedValue({}),
            deleteProject: vi.fn().mockResolvedValue({}),
          },
        }),
      );

      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByText('My Song')).toBeTruthy();
      });

      const search = screen.getByLabelText('Search projects');
      fireEvent.change(search, { target: { value: 'zzz' } });

      await waitFor(() => {
        expect(screen.queryByText('My Song')).toBeNull();
      });
      expect(screen.getByText('No projects match your search.')).toBeTruthy();
    });
  });

  // ---- Chat Interface ----------------------------------------------------

  describe('Chat Interface', () => {
    it('shows the empty state message initially', () => {
      render(<App />);
      dismissTutorial();
      expect(screen.getByText(/Start the conversation by sending a message/)).toBeTruthy();
    });

    it('has a chat input with correct placeholder', () => {
      render(<App />);
      dismissTutorial();
      const chatInput = screen.getByPlaceholderText('Type your message...');
      expect(chatInput).toBeTruthy();
    });

    it('disables the Send button when input is empty', () => {
      render(<App />);
      dismissTutorial();
      const sendBtn = screen.getByText('Send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(true);
    });

    it('enables the Send button when input has text', () => {
      render(<App />);
      dismissTutorial();
      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'Hello' } });
      const sendBtn = screen.getByText('Send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });

    it('sends a message and displays user + assistant messages', async () => {
      render(<App />);
      dismissTutorial();

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'Hi there' } });

      const form = chatInput.closest('form')!;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(screen.getByText('Hi there')).toBeTruthy();
      });

      await waitFor(() => {
        expect(screen.getByText('Hello from the agent!')).toBeTruthy();
      });
    });

    it('renders assistant markdown content (bold, list, inline code)', async () => {
      const { runAgentStream } = await getApiMock();
      (runAgentStream as ReturnType<typeof vi.fn>).mockImplementationOnce(
        async (_baseUrl: string, _payload: any, onEvent: (e: any) => void) => {
          onEvent({
            type: 'reply',
            data: { reply: '**Bold**\n\n- first item\n\nUse `cmd` now.' },
          });
        },
      );

      render(<App />);
      dismissTutorial();

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'Render markdown please' } });
      const form = chatInput.closest('form')!;

      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(screen.getByText('first item')).toBeTruthy();
      });

      expect(document.querySelector('.message-content strong')?.textContent).toBe('Bold');
      expect(document.querySelector('.message-content code')?.textContent).toBe('cmd');
    });

    it('uses exportTokens for authenticated requests', async () => {
      const status = await setupLoggedIn();
      const { runAgentStream } = await getApiMock();

      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByText('Logged in')).toBeTruthy();
      });

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'Token handoff test' } });
      const form = chatInput.closest('form')!;

      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(runAgentStream).toHaveBeenCalled();
      });

      expect(status.exportTokens).toHaveBeenCalledTimes(1);

      const payload = (runAgentStream as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
      expect(payload.authTokens).toMatchObject({
        accessToken: 'exported-access-token',
        refreshToken: 'exported-refresh-token',
        expiresAt: 1234567890000,
      });
      expect(typeof payload.authTokens.clientId).toBe('string');
      expect(payload.authTokens.clientId.length).toBeGreaterThan(0);
    });

    it('does not send authTokens when unauthenticated', async () => {
      await setupLoggedOut();
      const { runAgentStream } = await getApiMock();

      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'No auth token test' } });
      const form = chatInput.closest('form')!;

      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(runAgentStream).toHaveBeenCalled();
      });

      const payload = (runAgentStream as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
      expect(payload.authTokens).toBeUndefined();
    });

    it('forwards exportTokens payload exactly, including empty refreshToken', async () => {
      const { audiotool } = await getAudiotoolMock();
      const status = createMockAuthenticatedClient({
        exportTokens: vi.fn().mockReturnValue({
          accessToken: 'edge-access-token',
          refreshToken: '',
          expiresAt: 1234567890000,
        }),
      });
      (audiotool as ReturnType<typeof vi.fn>).mockResolvedValue(status);

      const { runAgentStream } = await getApiMock();

      await act(async () => {
        render(<App />);
      });
      dismissTutorial();

      await act(async () => {
        fireEvent.click(screen.getByText('Check'));
      });

      await waitFor(() => {
        expect(screen.getByText('Logged in')).toBeTruthy();
      });

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'Empty refresh token edge case' } });
      const form = chatInput.closest('form')!;

      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(runAgentStream).toHaveBeenCalled();
      });

      const payload = (runAgentStream as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1];
      expect(status.exportTokens).toHaveBeenCalledTimes(1);
      expect(payload.authTokens).toMatchObject({
        accessToken: 'edge-access-token',
        refreshToken: '',
        expiresAt: 1234567890000,
      });
    });

    it('clears the input after sending', async () => {
      render(<App />);
      dismissTutorial();

      const chatInput = screen.getByPlaceholderText('Type your message...') as HTMLInputElement;
      fireEvent.change(chatInput, { target: { value: 'Hello' } });

      const form = chatInput.closest('form')!;
      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(chatInput.value).toBe('');
      });
    });

    it('clears all messages when Clear chat is clicked', async () => {
      render(<App />);
      dismissTutorial();

      // Send a message first
      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'To be cleared' } });
      const form = chatInput.closest('form')!;
      await act(async () => {
        fireEvent.submit(form);
      });
      await waitFor(() => {
        expect(screen.getByText('To be cleared')).toBeTruthy();
      });

      // Clear
      fireEvent.click(screen.getByText('Clear chat'));

      await waitFor(() => {
        expect(screen.getByText(/Start the conversation by sending a message/)).toBeTruthy();
      });
    });
  });

  // ---- Settings ----------------------------------------------------------

  describe('Settings', () => {
    it('opens settings sidebar when cogwheel is clicked', () => {
      render(<App />);
      dismissTutorial();
      openSettings();
      expect(screen.getByText('Settings')).toBeTruthy();
      expect(screen.getByText('Appearance')).toBeTruthy();
    });

    it('closes settings sidebar when close button is clicked', () => {
      render(<App />);
      dismissTutorial();
      openSettings();
      expect(screen.getByText('Appearance')).toBeTruthy();

      const closeBtn = screen.getByLabelText('Close settings');
      fireEvent.click(closeBtn);

      expect(screen.queryByText('Appearance')).toBeNull();
    });

    it('toggles dark mode and updates document attribute', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      // Find the Dark Mode toggle switch
      const darkModeSwitch = screen.getByText('Dark Mode')
        .closest('.setting-item')!
        .querySelector('[role="switch"]')!;

      await act(async () => {
        fireEvent.click(darkModeSwitch);
      });

      await waitFor(() => {
        expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
      });
      expect(localStorage.getItem('darkMode')).toBe('true');
    });

    it('persists font size to localStorage when changed', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const fontInput = screen.getByLabelText('Font size in pixels') as HTMLInputElement;
      fireEvent.change(fontInput, { target: { value: '18' } });

      // Font size applies on Enter key
      await act(async () => {
        fireEvent.keyDown(fontInput, { key: 'Enter', code: 'Enter' });
      });

      await waitFor(() => {
        expect(document.documentElement.style.fontSize).toBe('18px');
      });
      expect(localStorage.getItem('fontSize')).toBe('18');
    });

    it('toggles show timestamps and persists to localStorage', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const timestampsSwitch = screen.getByText('Show Timestamps')
        .closest('.setting-item')!
        .querySelector('[role="switch"]')!;

      // Default is true; clicking should set to false
      await act(async () => {
        fireEvent.click(timestampsSwitch);
      });

      await waitFor(() => {
        expect(localStorage.getItem('showTimestamps')).toBe('false');
      });
    });

    it('changes LLM provider and persists to localStorage', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const providerSelect = screen.getByLabelText('LLM provider');
      await act(async () => {
        fireEvent.change(providerSelect, { target: { value: 'anthropic' } });
      });

      await waitFor(() => {
        expect(localStorage.getItem('llm.provider')).toBe('anthropic');
      });
    });

    it('changes theme via the select and persists to localStorage', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const themeSelect = screen.getByLabelText('Color theme');
      await act(async () => {
        fireEvent.change(themeSelect, { target: { value: 'ivory' } });
      });

      await waitFor(() => {
        expect(document.documentElement.getAttribute('data-color-theme')).toBe('ivory');
      });
      expect(localStorage.getItem('theme')).toBe('ivory');
    });
  });

  // ---- Tutorial ----------------------------------------------------------

  describe('Tutorial', () => {
    it('displays the tutorial overlay on first render', () => {
      render(<App />);
      // Tutorial step 1 title might conflict with sidebar heading, use getAllByText
      const consoleElements = screen.getAllByText('Console');
      expect(consoleElements.length).toBeGreaterThanOrEqual(1);
      expect(
        screen.getByText(
          /This is the console where you can log in and manage your projects\. Click/,
        ),
      ).toBeTruthy();
    });

    it('advances to the next tutorial step when Next is clicked', () => {
      render(<App />);
      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('Chat Box')).toBeTruthy();
      expect(
        screen.getByText(
          /This is the chat box where you can talk to the agent, paste ABC notation, generate music/,
        ),
      ).toBeTruthy();
    });

    it('dismisses the tutorial when Skip is clicked', () => {
      render(<App />);
      dismissTutorial();

      // Tutorial text should be gone
      expect(
        screen.queryByText(
          /This is the console where you can log in and manage your projects\. Click/,
        ),
      ).toBeNull();
      expect(localStorage.getItem('tutorial.seen')).toBe('true');
    });

    it('shows Finish on the last tutorial step and dismisses on click', () => {
      render(<App />);
      // Step 1 -> 2 -> 3
      fireEvent.click(screen.getByText('Next'));
      fireEvent.click(screen.getByText('Next'));

      expect(screen.getByText('Finish')).toBeTruthy();

      fireEvent.click(screen.getByText('Finish'));
      expect(
        screen.queryByText(
          /Open the Settings Menu to customize your experience and input your API keys\./,
        ),
      ).toBeNull();
      expect(localStorage.getItem('tutorial.seen')).toBe('true');
    });
  });

  // ---- Error Handling ----------------------------------------------------

  describe('Error Handling', () => {
    it('displays an error message when runAgentStream rejects', async () => {
      const { runAgentStream } = await getApiMock();
      (runAgentStream as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network failure'));

      render(<App />);
      dismissTutorial();

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'Hello' } });
      const form = chatInput.closest('form')!;

      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(screen.getByText('Error: Network failure')).toBeTruthy();
      });
    });

    it('re-enables Send button after an error', async () => {
      const { runAgentStream } = await getApiMock();
      (runAgentStream as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('fail'));

      render(<App />);
      dismissTutorial();

      const chatInput = screen.getByPlaceholderText('Type your message...');
      fireEvent.change(chatInput, { target: { value: 'test' } });
      const form = chatInput.closest('form')!;

      await act(async () => {
        fireEvent.submit(form);
      });

      await waitFor(() => {
        expect(screen.getByText(/Error:/)).toBeTruthy();
      });

      // Type something new and check button is enabled
      fireEvent.change(chatInput, { target: { value: 'retry' } });
      const sendBtn = screen.getByText('Send') as HTMLButtonElement;
      expect(sendBtn.disabled).toBe(false);
    });
  });

  // ---- Accessibility Settings --------------------------------------------

  describe('Accessibility Settings', () => {
    it('toggles reduce motion attribute on document', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const toggle = screen.getByText('Reduce Motion')
        .closest('.setting-item')!
        .querySelector('[role="switch"]')!;

      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(document.documentElement.getAttribute('data-reduce-motion')).toBe('true');
      });
      expect(localStorage.getItem('reduceMotion')).toBe('true');
    });

    it('applies colorblind theme to document when selected', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const colorblindSelect = screen.getByLabelText('Colorblindness theme');
      await act(async () => {
        fireEvent.change(colorblindSelect, { target: { value: 'deuteranopia' } });
      });

      await waitFor(() => {
        expect(document.documentElement.getAttribute('data-color-theme')).toBe('deuteranopia');
      });
      expect(localStorage.getItem('colorblindnessTheme')).toBe('deuteranopia');
    });

    it('toggles auto scroll and persists to localStorage', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const toggle = screen.getByText('Auto Scroll')
        .closest('.setting-item')!
        .querySelector('[role="switch"]')!;

      // Default is true; clicking sets to false
      await act(async () => {
        fireEvent.click(toggle);
      });

      await waitFor(() => {
        expect(localStorage.getItem('autoScroll')).toBe('false');
      });
    });

    it('changes message density and persists to localStorage', async () => {
      render(<App />);
      dismissTutorial();
      openSettings();

      const select = screen.getByLabelText('Message bubble density');
      await act(async () => {
        fireEvent.change(select, { target: { value: 'compact' } });
      });

      await waitFor(() => {
        expect(localStorage.getItem('messageDensity')).toBe('compact');
      });
    });
  });
});
