import { useEffect, useRef, useState } from 'react';
import {
  createAudiotoolClient,
  getLoginStatus,
  type AudiotoolClient,
  type LoginStatus,
  type SyncedDocument,
} from '@audiotool/nexus';
import './App.css';
import { runAgent } from './api';

type Role = 'user' | 'assistant';

type Message = {
  id: string;
  role: Role;
  content: string;
  timestamp: string;
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

  const handleConnectProject = async () => {
    if (!client) {
      setProjectError('Login first to create a synced document.');
      setProjectStatus('error');
      return;
    }
    if (!projectUrl.trim()) {
      setProjectError('Project URL is required.');
      setProjectStatus('error');
      return;
    }

    setProjectStatus('connecting');
    setProjectError(null);
    try {
      if (syncedDocument) {
        await syncedDocument.stop();
      }
      const doc = await client.createSyncedDocument({
        project: projectUrl.trim(),
      });
      await doc.start();
      setSyncedDocument(doc);
      setProjectStatus('connected');
    } catch (error) {
      setProjectError(formatError(error));
      setProjectStatus('error');
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
    } catch (error) {
      setProjectError(formatError(error));
      setProjectStatus('error');
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
      const response = await runAgent('http://127.0.0.1:8000', {
        prompt: trimmed,
        keywords: [],
        loop: 1,
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
        : 'Paste a project URL to start syncing.';

  return (
    <div className="page">
      <header className="header">
        <div>
          <p className="eyebrow">AudioTool Sample UI</p>
          <h1>Nexus Agent Console</h1>
          <p className="subtitle">Authenticate with Audiotool and connect a project.</p>
          <p className="subtitle">Keep the chat open to guide the agent once a project is synced.</p>
        </div>
        <button type="button" className="ghost" onClick={handleReset}>
          Clear chat
        </button>
      </header>

      <section className="nexus-panel">
        <div className="nexus-header">
          <div>
            <p className="eyebrow">Audiotool Nexus</p>
            <h2>Account + Project Connection</h2>
            <p className="subtitle">
              Use your app credentials to sign in, then attach a project URL.
            </p>
          </div>
          <div className="nexus-actions">
            <button type="button" className="ghost" onClick={fetchLoginStatus} disabled={isCheckingAuth}>
              {isCheckingAuth ? 'Checking...' : 'Check login'}
            </button>
            {authStatus?.loggedIn ? (
              <button type="button" onClick={handleLogout}>
                Logout
              </button>
            ) : (
              <button type="button" onClick={handleLogin} disabled={isCheckingAuth}>
                Login
              </button>
            )}
          </div>
        </div>

        <div className="nexus-grid">
          <div className="nexus-card">
            <h3>Project connection</h3>
            <label>
              Project URL
              <input
                value={projectUrl}
                onChange={(event) => setProjectUrl(event.target.value)}
                placeholder="https://beta.audiotool.com/studio?project=your-project-id"
              />
            </label>
            <div className="button-row">
              <button type="button" onClick={handleConnectProject} disabled={projectStatus === 'connecting'}>
                {projectStatus === 'connecting' ? 'Connecting...' : 'Connect project'}
              </button>
              <button type="button" className="ghost" onClick={handleDisconnectProject} disabled={!syncedDocument}>
                Disconnect
              </button>
            </div>
            <p className="hint">
              After connecting, keep this tab open so the agent can operate on the live document.
            </p>
          </div>
        </div>

        <div className="nexus-status">
          <div>
            <span className={authPillClass}>
              {authStatus?.loggedIn ? 'Logged in' : 'Logged out'}
            </span>
            <span className="status-text">
              {authStatus?.loggedIn
                ? `User: ${authUser ?? 'Fetching user...'}`
                : 'Sign in to authorize project access.'}
            </span>
          </div>
          <div>
            <span className={projectPillClass}>
              {projectLabel}
            </span>
            <span className="status-text">
              {projectDetail}
            </span>
          </div>
          {(authError || projectError) && (
            <div className="status-error">
              {authError ? `Auth error: ${authError}` : null}
              {authError && projectError ? ' | ' : null}
              {projectError ? `Project error: ${projectError}` : null}
            </div>
          )}
        </div>
      </section>

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
  );
}
