import { useEffect, useRef, useState } from 'react';
import {
  createAudiotoolClient,
  getLoginStatus,
  type AudiotoolClient,
  type LoginStatus,
  type SyncedDocument,
} from '@audiotool/nexus';
import './App.css';
import { runAgent, type AuthTokens, type ConversationMessage, type LLMProvider } from './api';

type Role = 'user' | 'assistant';

type Message = {
  id: string;
  role: Role;
  content: string;
  timestamp: string;
};

type ProjectItem = {
  name: string;
  displayName: string;
};

const createId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`;

const nowStamp = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

const readEnv = (value: string | undefined) => (value && value.trim() ? value : undefined);

const envClientId = readEnv(import.meta.env.VITE_AUDIOTOOL_CLIENT_ID);
const envRedirectUrl = readEnv(import.meta.env.VITE_AUDIOTOOL_REDIRECT_URL);
const envScope = readEnv(import.meta.env.VITE_AUDIOTOOL_SCOPE);

const defaultRedirectUrl =
  envRedirectUrl ??
  (typeof window !== 'undefined' ? `${window.location.origin}/` : 'http://127.0.0.1:5173/');

const loadSetting = (key: string, fallback: string) => {
  if (typeof window === 'undefined') {
    return fallback;
  }
  const value = window.localStorage.getItem(key);
  return value ?? fallback;
};

const saveSetting = (key: string, value: string) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (value) {
    window.localStorage.setItem(key, value);
  } else {
    window.localStorage.removeItem(key);
  }
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const extractProjectId = (name: string) => name.replace(/^projects\//, '');

const getStudioUrl = (projectName: string) =>
  `https://beta.audiotool.com/studio?project=${extractProjectId(projectName)}`;

const extractAuthTokens = (clientId: string, redirectUrl: string, scope: string): AuthTokens | null => {
  if (typeof window === 'undefined') {
    return null;
  }

  const accessToken = window.localStorage.getItem(`oidc_${clientId}_oidc_access_token`);
  const expiresAtStr = window.localStorage.getItem(`oidc_${clientId}_oidc_expires_at`);
  const refreshToken = window.localStorage.getItem(`oidc_${clientId}_oidc_refresh_token`);

  if (!accessToken || !expiresAtStr) {
    return null;
  }

  const validRefreshToken =
    refreshToken &&
      refreshToken !== 'undefined' &&
      refreshToken !== 'null' &&
      refreshToken.trim() !== ''
      ? refreshToken
      : undefined;

  return {
    accessToken,
    expiresAt: parseInt(expiresAtStr, 10),
    refreshToken: validRefreshToken,
    clientId,
    redirectUrl,
    scope,
  };
};

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isRunning, setIsRunning] = useState(false);
  const authConfig = {
    clientId: envClientId ?? '',
    redirectUrl: envRedirectUrl ?? defaultRedirectUrl,
    scope: envScope ?? 'project:write',
  };
  const [authStatus, setAuthStatus] = useState<LoginStatus | null>(null);
  const [authUser, setAuthUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [client, setClient] = useState<AudiotoolClient | null>(null);
  const [projectUrl, setProjectUrl] = useState(
    loadSetting('audiotool.projectUrl', ''),
  );
  const [projectStatus, setProjectStatus] = useState<
    'idle' | 'connecting' | 'connected' | 'error'
  >('idle');
  const [projectError, setProjectError] = useState<string | null>(null);
  const [syncedDocument, setSyncedDocument] = useState<SyncedDocument | null>(null);
  const hasAutoChecked = useRef(false);

  const [projectList, setProjectList] = useState<ProjectItem[]>([]);
  const [projectListLoading, setProjectListLoading] = useState(false);
  const [projectListError, setProjectListError] = useState<string | null>(null);
  const [projectListToken, setProjectListToken] = useState('');
  const [isCreatingProject, setIsCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | null>(null);
  const [connectedProjectName, setConnectedProjectName] = useState<string | null>(null);
  const [settingsSidebarOpen, setSettingsSidebarOpen] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LLMProvider>(() =>
    (loadSetting('llm.provider', 'gemini') as LLMProvider) || 'gemini'
  );
  const [llmApiKey, setLlmApiKey] = useState(() => loadSetting('llm.apiKey', ''));
  const [darkMode, setDarkMode] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('darkMode') === 'true';
    }
    return false;
  });
  const [fontSize, setFontSize] = useState(() => {
    if (typeof window !== 'undefined') {
      return parseFloat(window.localStorage.getItem('fontSize') || '14');
    }
    return 14;
  });
  const [tempFontSize, setTempFontSize] = useState(fontSize.toString());
  const [reduceMotion, setReduceMotion] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('reduceMotion') === 'true';
    }
    return false;
  });
  const [highContrast, setHighContrast] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('highContrast') === 'true';
    }
    return false;
  });
  const [showTimestamps, setShowTimestamps] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('showTimestamps') !== 'false';
    }
    return true;
  });
  const [autoScroll, setAutoScroll] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('autoScroll') !== 'false';
    }
    return true;
  });
  const [theme, setTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('theme') || 'default';
    }
    return 'default';
  });
  const [customColor, setCustomColor] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('customColor') || '#1b7f79';
    }
    return '#1b7f79';
  });
  const [useCustomColor, setUseCustomColor] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('useCustomColor') === 'true';
    }
    return false;
  });
  const [messageDensity, setMessageDensity] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('messageDensity') || 'comfortable';
    }
    return 'comfortable';
  });
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setTempFontSize(fontSize.toString());
  }, [fontSize]);
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      if (darkMode) {
        root.setAttribute('data-theme', 'dark');
        window.localStorage.setItem('darkMode', 'true');
      } else {
        root.removeAttribute('data-theme');
        window.localStorage.setItem('darkMode', 'false');
      }
    }
  }, [darkMode]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      document.documentElement.style.fontSize = `${fontSize}px`;
      window.localStorage.setItem('fontSize', fontSize.toString());
    }
  }, [fontSize]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      if (reduceMotion) {
        root.setAttribute('data-reduce-motion', 'true');
        window.localStorage.setItem('reduceMotion', 'true');
      } else {
        root.removeAttribute('data-reduce-motion');
        window.localStorage.setItem('reduceMotion', 'false');
      }
    }
  }, [reduceMotion]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      if (highContrast) {
        root.setAttribute('data-high-contrast', 'true');
        window.localStorage.setItem('highContrast', 'true');
      } else {
        root.removeAttribute('data-high-contrast');
        window.localStorage.setItem('highContrast', 'false');
      }
    }
  }, [highContrast]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      root.setAttribute('data-color-theme', theme);
      window.localStorage.setItem('theme', theme);
      // Disable custom color when theme changes
      setUseCustomColor(false);
    }
  }, [theme]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('showTimestamps', showTimestamps.toString());
    }
  }, [showTimestamps]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('autoScroll', autoScroll.toString());
    }
  }, [autoScroll]);

  useEffect(() => {
    if (autoScroll && messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages, autoScroll]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('customColor', customColor);
      const root = document.documentElement;
      if (useCustomColor) {
        root.style.setProperty('--accent', customColor);
        root.style.setProperty('--accent-hover', customColor + 'cc');
      }
    }
  }, [customColor, useCustomColor]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('useCustomColor', useCustomColor.toString());
      const root = document.documentElement;
      if (!useCustomColor) {
        // Remove inline styles to restore theme colors
        root.style.removeProperty('--accent');
        root.style.removeProperty('--accent-hover');
      } else {
        // Apply custom color if enabled
        root.style.setProperty('--accent', customColor);
        root.style.setProperty('--accent-hover', customColor + 'cc');
      }
    }
  }, [useCustomColor]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('messageDensity', messageDensity);
      const densityMap: Record<string, string> = {
        compact: '8px',
        comfortable: '12px',
        spacious: '22px',
      };
      document.documentElement.style.setProperty('--message-gap', densityMap[messageDensity] || '12px');
    }
  }, [messageDensity]);

  const addMessage = (role: Role, content: string) => {
    setMessages((prev) => [
      ...prev,
      { id: createId(), role, content, timestamp: nowStamp() },
    ]);
  };

  useEffect(() => {
    saveSetting('audiotool.projectUrl', projectUrl);
  }, [projectUrl]);

  useEffect(() => {
    saveSetting('llm.provider', llmProvider);
  }, [llmProvider]);
  useEffect(() => {
    saveSetting('llm.apiKey', llmApiKey);
  }, [llmApiKey]);

  useEffect(() => {
    return () => {
      if (syncedDocument) {
        void syncedDocument.stop();
      }
    };
  }, [syncedDocument]);

  const fetchProjects = async (currentClient: AudiotoolClient, append = false, token = '') => {
    setProjectListLoading(true);
    setProjectListError(null);
    try {
      const response = await currentClient.api.projectService.listProjects({
        pageSize: 20,
        pageToken: append ? token : '',
      });
      if (response instanceof Error) {
        throw response;
      }
      const items: ProjectItem[] = (response.projects ?? []).map((p) => ({
        name: p.name ?? '',
        displayName: p.displayName || extractProjectId(p.name ?? ''),
      }));
      setProjectList((prev) => (append ? [...prev, ...items] : items));
      setProjectListToken(response.nextPageToken ?? '');
    } catch (error) {
      setProjectListError(formatError(error));
    } finally {
      setProjectListLoading(false);
    }
  };

  useEffect(() => {
    if (client) {
      void fetchProjects(client);
    } else {
      setProjectList([]);
      setProjectListToken('');
      setConnectedProjectName(null);
    }
  }, [client]);

  const fetchLoginStatus = async () => {
    if (!authConfig.clientId.trim()) {
      setAuthError('Client ID is missing. Set VITE_AUDIOTOOL_CLIENT_ID in frontend/.env.');
      return null;
    }

    setIsCheckingAuth(true);
    setAuthError(null);
    try {
      const status = await getLoginStatus({
        clientId: authConfig.clientId.trim(),
        redirectUrl: authConfig.redirectUrl.trim(),
        scope: authConfig.scope.trim(),
      });
      setAuthStatus(status);

      if (status.loggedIn) {
        const userName = await status.getUserName();
        setAuthUser(userName instanceof Error ? null : userName);
        const nextClient = await createAudiotoolClient({ authorization: status });
        setClient(nextClient);
      } else {
        setAuthUser(null);
        setClient(null);
        setSyncedDocument(null);
        setProjectStatus('idle');
        if (status.error) {
          setAuthError(status.error.message);
        }
      }

      return status;
    } catch (error) {
      setAuthError(formatError(error));
      setAuthStatus(null);
      setAuthUser(null);
      setClient(null);
      return null;
    } finally {
      setIsCheckingAuth(false);
    }
  };

  const handleLogin = async () => {
    const status = authStatus ?? (await fetchLoginStatus());
    if (status && !status.loggedIn) {
      await status.login();
    }
  };

  const handleLogout = () => {
    if (authStatus && authStatus.loggedIn) {
      authStatus.logout();
    }
  };

  const handleConnectToProject = async (projectName: string) => {
    if (!client) {
      setProjectError('Login first to create a synced document.');
      setProjectStatus('error');
      return;
    }

    const studioUrl = getStudioUrl(projectName);
    setProjectUrl(studioUrl);
    setConnectedProjectName(projectName);
    setProjectStatus('connecting');
    setProjectError(null);
    setMessages([]);
    try {
      if (syncedDocument) {
        await syncedDocument.stop();
      }
      const doc = await client.createSyncedDocument({
        project: studioUrl,
      });
      await doc.start();
      setSyncedDocument(doc);
      setProjectStatus('connected');
    } catch (error) {
      setProjectError(formatError(error));
      setProjectStatus('error');
      setConnectedProjectName(null);
    }
  };

  const handleDisconnectProject = async () => {
    if (!syncedDocument) {
      return;
    }
    setProjectStatus('connecting');
    try {
      await syncedDocument.stop();
      setSyncedDocument(null);
      setProjectStatus('idle');
      setConnectedProjectName(null);
    } catch (error) {
      setProjectError(formatError(error));
      setProjectStatus('error');
    }
  };

  const handleCreateProject = async () => {
    if (!client) return;
    setIsCreatingProject(true);
    setCreateProjectError(null);
    try {
      const response = await client.api.projectService.createProject({
        project: {},
      });
      if (response instanceof Error) {
        throw response;
      }
      const created = response.project;
      if (created) {
        const item: ProjectItem = {
          name: created.name ?? '',
          displayName: created.displayName || extractProjectId(created.name ?? ''),
        };
        setProjectList((prev) => [item, ...prev]);
        await handleConnectToProject(item.name);
      }
    } catch (error) {
      setCreateProjectError(formatError(error));
    } finally {
      setIsCreatingProject(false);
    }
  };

  const handleLoadMore = () => {
    if (client && projectListToken) {
      void fetchProjects(client, true, projectListToken);
    }
  };

  useEffect(() => {
    if (hasAutoChecked.current || !envClientId) {
      return;
    }
    hasAutoChecked.current = true;
    void fetchLoginStatus();
  }, [envClientId]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isRunning) {
      return;
    }

    setIsRunning(true);
    addMessage('user', trimmed);
    setInput('');

    try {
      const authTokens = authStatus?.loggedIn
        ? extractAuthTokens(
          authConfig.clientId.trim(),
          authConfig.redirectUrl.trim(),
          authConfig.scope.trim()
        )
        : null;

      const projectUrlToSend = projectStatus === 'connected' && projectUrl.trim()
        ? projectUrl.trim()
        : undefined;

      const history: ConversationMessage[] = messages
        .slice(-20)
        .map((m) => ({
          role: (m.role === 'user' ? 'user' : 'model') as 'user' | 'model',
          content: m.content,
        }));

      const response = await runAgent('http://127.0.0.1:8000', {
        prompt: trimmed,
        keywords: [],
        loop: 1,
        authTokens: authTokens || undefined,
        projectUrl: projectUrlToSend,
        messages: history.length > 0 ? history : undefined,
        llmProvider,
        llmApiKey: llmApiKey.trim() || undefined,
      });
      addMessage('assistant', response.reply);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      addMessage('assistant', `Error: ${message}`);
    } finally {
      setIsRunning(false);
    }
  };

  const handleReset = () => {
    setMessages([]);
  };

  const authPillClass = `status-pill ${authStatus?.loggedIn ? 'ok' : 'warn'}`;
  const projectPillClass = `status-pill ${projectStatus === 'connected' ? 'ok' : 'warn'}`;
  const projectLabel =
    projectStatus === 'connected'
      ? 'Project connected'
      : projectStatus === 'error'
        ? 'Project error'
        : 'Project idle';
  const projectDetail =
    projectStatus === 'connected'
      ? 'Synced document is live and ready for actions.'
      : projectStatus === 'error'
        ? 'Review the error and try connecting again.'
        : 'Select a project to start syncing.';

  const isActiveProject = (p: ProjectItem) =>
    projectStatus === 'connected' && connectedProjectName === p.name;

  return (
    <div className="page">
      <div className="app-layout">
        <aside className="sidebar">
          <div className="sidebar-brand">
            <p className="eyebrow">Nexus Agent</p>
            <h1>Console</h1>
          </div>

          <div className="sidebar-auth">
            <div className="sidebar-auth-status">
              <span className={authPillClass}>
                {authStatus?.loggedIn ? 'Logged in' : 'Logged out'}
              </span>
              {authStatus?.loggedIn && authUser && (
                <span className="sidebar-user">{authUser}</span>
              )}
            </div>
            <div className="sidebar-auth-actions">
              <button type="button" className="ghost small" onClick={fetchLoginStatus} disabled={isCheckingAuth}>
                {isCheckingAuth ? 'Checking...' : 'Check'}
              </button>
              {authStatus?.loggedIn ? (
                <button type="button" className="small" onClick={handleLogout}>
                  Logout
                </button>
              ) : (
                <button type="button" className="small" onClick={handleLogin} disabled={isCheckingAuth}>
                  Login
                </button>
              )}
            </div>
          </div>

          {authError && (
            <div className="sidebar-error">{authError}</div>
          )}

          <div className="sidebar-divider" />

          <div className="sidebar-projects">
            <button
              type="button"
              className="create-project-btn"
              onClick={handleCreateProject}
              disabled={!client || isCreatingProject}
            >
              {isCreatingProject ? 'Creating...' : 'New Project'}
            </button>

            {createProjectError && (
              <div className="sidebar-error">{createProjectError}</div>
            )}

            {client && (
              <>
                <h4 className="project-list-heading">Projects</h4>

                {projectListError && (
                  <div className="sidebar-error">{projectListError}</div>
                )}

                <div className="project-list-scroll">
                  {projectListLoading && projectList.length === 0 ? (
                    <p className="hint centered">Loading...</p>
                  ) : projectList.length === 0 && !projectListError ? (
                    <p className="hint centered">No projects yet.</p>
                  ) : (
                    <div className="project-list">
                      {projectList.map((project) => {
                        const active = isActiveProject(project);
                        return (
                          <div
                            key={project.name}
                            className={`project-list-item${active ? ' active' : ''}`}
                          >
                            <span className="project-list-item-name">
                              {project.displayName}
                            </span>
                            <div className="project-list-item-actions">
                              {active ? (
                                <button
                                  type="button"
                                  className="ghost tiny"
                                  onClick={handleDisconnectProject}
                                >
                                  Disconnect
                                </button>
                              ) : (
                                <button
                                  type="button"
                                  className="tiny"
                                  onClick={() => handleConnectToProject(project.name)}
                                  disabled={projectStatus === 'connecting'}
                                >
                                  Connect
                                </button>
                              )}
                              <a
                                href={getStudioUrl(project.name)}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="open-tab-link"
                                title="Open in Audiotool"
                              >
                                &#8599;
                              </a>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {projectListToken && (
                  <button
                    type="button"
                    className="ghost tiny load-more-btn"
                    onClick={handleLoadMore}
                    disabled={projectListLoading}
                  >
                    {projectListLoading ? 'Loading...' : 'Load More'}
                  </button>
                )}
              </>
            )}
          </div>

          <div className="sidebar-footer">
            <div className="sidebar-footer-row">
              <span className={projectPillClass}>{projectLabel}</span>
              <span className="status-text">{projectDetail}</span>
            </div>
            {projectError && (
              <div className="sidebar-error">{projectError}</div>
            )}
          </div>
        </aside>

        <div className="main-area">
          <header className="main-header">
            <div>
              <p className="subtitle">
                {projectStatus === 'connected'
                  ? 'Project synced. Chat with the agent below.'
                  : 'Connect a project in the sidebar to get started.'}
              </p>
            </div>
            <div className="header-actions">
              <button type="button" className="ghost small" onClick={handleReset}>
                Clear chat
              </button>
              <button
                type="button"
                className="cogwheel-btn"
                onClick={() => setSettingsSidebarOpen(!settingsSidebarOpen)}
                aria-label="Toggle settings"
                title="Settings"
              >
                ⚙
              </button>
            </div>
          </header>

          <main className="chat-card">
            <div className="messages" ref={messagesContainerRef}>
              {messages.length === 0 ? (
                <div className="empty">
                  <p>Start the conversation by sending a message.</p>
                </div>
              ) : (
                messages.map((message) => (
                  <div key={message.id} className={`message ${message.role}`}>
                    <div className="message-meta">
                      <span className="role">{message.role}</span>
                      {showTimestamps && <span className="time">{message.timestamp}</span>}
                    </div>
                    <p>{message.content}</p>
                  </div>
                ))
              )}
            </div>

            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                handleSend();
              }}
            >
              <input
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="Type your message..."
                aria-label="Chat message"
              />
              <button type="submit" disabled={!input.trim() || isRunning}>
                {isRunning ? 'Sending...' : 'Send'}
              </button>
            </form>
          </main>
        </div>

        {settingsSidebarOpen && (
          <aside className="settings-sidebar">
            <div className="settings-header">
              <h3>Settings</h3>
              <button
                type="button"
                className="close-btn"
                onClick={() => setSettingsSidebarOpen(false)}
                aria-label="Close settings"
              >
                ✕
              </button>
            </div>
            <div className="settings-content">
              <div className="settings-section">
                <h4>Appearance</h4>
                <div className="setting-item">
                  <span className="setting-label">Dark Mode</span>
                  <div
                    className={`toggle-switch${darkMode ? ' active' : ''}`}
                    onClick={() => setDarkMode(!darkMode)}
                    role="switch"
                    aria-checked={darkMode}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setDarkMode(!darkMode);
                      }
                    }}
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label">Theme</span>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                    className="theme-select"
                    aria-label="Color theme"
                  >
                    <option value="default">Default</option>
                    <option value="black-red">Redliner</option>
                    <option value="ivory">Ivory</option>
                  </select>
                </div>
                <div className="setting-item">
                  <span className="setting-label">Custom Color</span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <div
                      className={`toggle-switch${useCustomColor ? ' active' : ''}`}
                      onClick={() => setUseCustomColor(!useCustomColor)}
                      role="switch"
                      aria-checked={useCustomColor}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setUseCustomColor(!useCustomColor);
                        }
                      }}
                    />
                    <input
                      type="color"
                      value={customColor}
                      onChange={(e) => setCustomColor(e.target.value)}
                      className="color-picker-input"
                      aria-label="Custom accent color"
                      disabled={!useCustomColor}
                      style={{ opacity: useCustomColor ? 1 : 0.5, cursor: useCustomColor ? 'pointer' : 'not-allowed' }}
                    />
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <h4>Accessibility</h4>
                <div className="setting-item">
                  <span className="setting-label">Reduce Motion</span>
                  <div
                    className={`toggle-switch${reduceMotion ? ' active' : ''}`}
                    onClick={() => setReduceMotion(!reduceMotion)}
                    role="switch"
                    aria-checked={reduceMotion}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setReduceMotion(!reduceMotion);
                      }
                    }}
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label">High Contrast</span>
                  <div
                    className={`toggle-switch${highContrast ? ' active' : ''}`}
                    onClick={() => setHighContrast(!highContrast)}
                    role="switch"
                    aria-checked={highContrast}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setHighContrast(!highContrast);
                      }
                    }}
                  />
                </div>
              </div>

              <div className="settings-section">
                <h4>User Preferences</h4>
                <div className="setting-item">
                  <span className="setting-label">Show Timestamps</span>
                  <div
                    className={`toggle-switch${showTimestamps ? ' active' : ''}`}
                    onClick={() => setShowTimestamps(!showTimestamps)}
                    role="switch"
                    aria-checked={showTimestamps}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setShowTimestamps(!showTimestamps);
                      }
                    }}
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label">Auto Scroll</span>
                  <div
                    className={`toggle-switch${autoScroll ? ' active' : ''}`}
                    onClick={() => setAutoScroll(!autoScroll)}
                    role="switch"
                    aria-checked={autoScroll}
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        setAutoScroll(!autoScroll);
                      }
                    }}
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label">Message Spacing</span>
                  <select
                    value={messageDensity}
                    onChange={(e) => setMessageDensity(e.target.value)}
                    className="theme-select"
                    aria-label="Message bubble density"
                  >
                    <option value="compact">Compact</option>
                    <option value="comfortable">Comfortable</option>
                    <option value="spacious">Spacious</option>
                  </select>
                </div>
                <div className="setting-item">
                  <span className="setting-label">Font Size</span>
                  <div className="font-size-controls">
                    <input
                      type="number"
                      min="8"
                      max="30"
                      value={tempFontSize}
                      onChange={(e) => setTempFontSize(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const newSize = parseFloat(e.currentTarget.value) || 14;
                          if (newSize >= 8 && newSize <= 30) {
                            setFontSize(newSize);
                          } else {
                            setTempFontSize(fontSize.toString());
                          }
                        }
                      }}
                      onBlur={() => setTempFontSize(fontSize.toString())}
                      className="font-size-input"
                      aria-label="Font size in pixels"
                    />
                    <button
                      type="button"
                      onClick={() => setFontSize(14)}
                      className="reset-btn"
                      title="Reset to default (14px)"
                    >
                      Reset
                    </button>
                  </div>
                </div>
              </div>

              <div className="settings-section">
                <h4>LLM / Assistant</h4>
                <div className="setting-item">
                  <span className="setting-label">Provider</span>
                  <select
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value as LLMProvider)}
                    className="theme-select"
                    aria-label="LLM provider"
                  >
                    <option value="gemini">Gemini (Google)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                  </select>
                </div>
                <div className="setting-item">
                  <span className="setting-label">API Key (optional)</span>
                  <input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    placeholder={llmProvider === 'gemini' ? 'Uses GEMINI_API_KEY if empty' : 'Uses ANTHROPIC_API_KEY if empty'}
                    className="font-size-input"
                    aria-label="API key for LLM provider"
                    autoComplete="off"
                  />
                </div>
              </div>

              <div className="settings-section">
                <h4>Developer Settings</h4>
                <div className="setting-item">
                  <span className="setting-label">DevSetting1</span>
                  <div
                    className="toggle-switch"
                    role="switch"
                    aria-checked="false"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                      }
                    }}
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label">DevSetting2</span>
                  <div
                    className="toggle-switch"
                    role="switch"
                    aria-checked="false"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                      }
                    }}
                  />
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
