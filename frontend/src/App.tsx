import { useEffect, useRef, useState } from 'react';
import {
  createAudiotoolClient,
  getLoginStatus,
  type AudiotoolClient,
  type LoginStatus,
  type SyncedDocument,
} from '@audiotool/nexus';
import './App.css';
import { runAgent, type AuthTokens, type ConversationMessage } from './api';

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
            <button type="button" className="ghost small" onClick={handleReset}>
              Clear chat
            </button>
          </header>

          <main className="chat-card">
            <div className="messages">
              {messages.length === 0 ? (
                <div className="empty">
                  <p>Start the conversation by sending a message.</p>
                </div>
              ) : (
                messages.map((message) => (
                  <div key={message.id} className={`message ${message.role}`}>
                    <div className="message-meta">
                      <span className="role">{message.role}</span>
                      <span className="time">{message.timestamp}</span>
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
      </div>
    </div>
  );
}
