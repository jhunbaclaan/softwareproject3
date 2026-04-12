import { useEffect, useRef, useState } from 'react';
import {
  createAudiotoolClient,
  getLoginStatus,
  type AudiotoolClient,
  type LoginStatus,
  type SyncedDocument,
} from '@audiotool/nexus';
import './App.css';
import { cancelAgentRun, getApiBaseUrl, runAgentStream, type AuthTokens, type ConversationMessage, type LLMProvider, type TraceItem, type DawContext } from './api';
import { importAudioBlobToProject } from './audiotool/importGeneratedAudio';

type Role = 'user' | 'assistant';

type Message = {
  id: string;
  role: Role;
  content: string;
  timestamp: string;
  traces?: TraceItem[];
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
const tutorialSeenStorageKey = 'tutorial.seen';

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

const INSTRUMENT_ENTITY_TYPES = new Set([
  'heisenberg', 'bassline', 'space', 'gakki', 'pulverisateur',
  'tonematrix', 'machiniste', 'matrixArpeggiator', 'pulsar',
  'kobolt', 'beatbox8', 'beatbox9', 'centroid', 'rasselbock',
]);

function getDawContext(doc: SyncedDocument | null): DawContext | undefined {
  if (!doc) return undefined;
  try {
    const allEntities = (doc as any).queryEntities?.get?.() ?? [];
    const config = allEntities.find((e: any) => e.entityType === 'config');
    if (!config) return undefined;
    const bpm = config.fields?.tempoBpm?.value as number | undefined;
    const num = config.fields?.signatureNumerator?.value as number | undefined;
    const den = config.fields?.signatureDenominator?.value as number | undefined;
    const ctx: DawContext = {};
    if (bpm != null) ctx.tempoBpm = bpm;
    if (num != null && den != null) ctx.timeSignature = `${num}/${den}`;

    const instruments = allEntities
      .filter((e: any) => INSTRUMENT_ENTITY_TYPES.has(e.entityType))
      .map((e: any) => e.entityType as string);
    if (instruments.length > 0) ctx.instruments = instruments;

    const trackCount = allEntities.filter(
      (e: any) => e.entityType === 'noteTrack' || e.entityType === 'audioTrack',
    ).length;
    if (trackCount > 0) ctx.trackCount = trackCount;

    return Object.keys(ctx).length > 0 ? ctx : undefined;
  } catch {
    return undefined;
  }
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [previewAudioUrl, setPreviewAudioUrl] = useState<string | null>(null);
  const [previewDawMessage, setPreviewDawMessage] = useState<string | null>(null);
  const [previewDawError, setPreviewDawError] = useState<string | null>(null);
  const audioImportLayoutRef = useRef(0);
  const [isRunning, setIsRunning] = useState(false);
  const isRunningRef = useRef(false);
  const streamAbortRef = useRef<AbortController | null>(null);
  const authConfig = {
    clientId: envClientId ?? '',
    redirectUrl: envRedirectUrl ?? defaultRedirectUrl,
    scope: envScope ?? 'project:write sample:write',
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
  const [elevenLabsApiKey, setElevenLabsApiKey] = useState(() => loadSetting('elevenlabs.apiKey', ''));
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
  const [dyslexiaFont, setDyslexiaFont] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('dyslexiaFont') || 'default';
    }
    return 'default';
  });
  const [colorblindnessTheme, setColorblindnessTheme] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('colorblindnessTheme') || 'none';
    }
    return 'none';
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
  const [buttonStyle, setButtonStyle] = useState(() => {
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('buttonStyle') || 'filled';
    }
    return 'filled';
  });
  const [tutorialStep, setTutorialStep] = useState(() => {
    if (typeof window !== 'undefined') {
      const seen = window.localStorage.getItem(tutorialSeenStorageKey) === 'true';
      return seen ? 0 : 1;
    }
    return 0;
  });
  const [cogwheelPos, setCogwheelPos] = useState({ top: '50px', right: '20px' });
  const cogwheelRef = useRef<HTMLButtonElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  const tutorialSteps = [
    { title: 'Console', text: 'This is the console where you can log in and manage your projects. Click "Connect" to connect to a project or "New Project" to create a new project. Click the arrow next the project name to open it in a new tab.' },
    { title: 'Chat Box', text: 'This is the chat box where you can talk to the agent, paste ABC notation, generate music, or learn how to use the DAW.' },
    { title: 'Settings Menu', text: 'Open the Settings Menu to customize your experience and input your API keys.' }
  ];

  const completeTutorial = () => {
    setTutorialStep(0);
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(tutorialSeenStorageKey, 'true');
    }
  };

  const nextTutorialStep = () => {
    if (tutorialStep < tutorialSteps.length) {
      setTutorialStep(tutorialStep + 1);
    } else {
      completeTutorial();
    }
  };

  const prevTutorialStep = () => {
    if (tutorialStep > 1) {
      setTutorialStep(tutorialStep - 1);
    }
  };

  const skipTutorial = () => {
    completeTutorial();
  };

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
        root.classList.add('no-transition-guard');
        root.removeAttribute('data-reduce-motion');
        window.localStorage.setItem('reduceMotion', 'false');
        void root.offsetHeight;
        requestAnimationFrame(() => {
          root.classList.remove('no-transition-guard');
        });
      }
    }
  }, [reduceMotion]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      if (dyslexiaFont !== 'default') {
        root.setAttribute('data-dyslexia-font', dyslexiaFont);
        window.localStorage.setItem('dyslexiaFont', dyslexiaFont);
      } else {
        root.removeAttribute('data-dyslexia-font');
        window.localStorage.setItem('dyslexiaFont', 'default');
      }
    }
  }, [dyslexiaFont]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      if (colorblindnessTheme !== 'none') {
        root.setAttribute('data-color-theme', colorblindnessTheme);
        window.localStorage.setItem('colorblindnessTheme', colorblindnessTheme);
      } else {
        // Remove colorblindness theme, fall back to regular theme
        root.setAttribute('data-color-theme', theme);
        window.localStorage.setItem('colorblindnessTheme', 'none');
      }
    }
  }, [colorblindnessTheme, theme]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      if (colorblindnessTheme === 'none') {
        root.setAttribute('data-color-theme', theme);
        window.localStorage.setItem('theme', theme);
        // Disable custom color when theme changes
        setUseCustomColor(false);
      }
    }
  }, [theme, colorblindnessTheme]);

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

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const root = document.documentElement;
      root.setAttribute('data-button-style', buttonStyle);
      window.localStorage.setItem('buttonStyle', buttonStyle);
    }
  }, [buttonStyle]);

  useEffect(() => {
    const updateCogwheelPos = () => {
      if (cogwheelRef.current) {
        const rect = cogwheelRef.current.getBoundingClientRect();
        setCogwheelPos({
          top: `${rect.top + rect.height / 2 - 18}px`,
          right: `${window.innerWidth - rect.left + 20}px`
        });
      }
    };
    updateCogwheelPos();
    window.addEventListener('resize', updateCogwheelPos);
    return () => window.removeEventListener('resize', updateCogwheelPos);
  }, [buttonStyle]);

  const addMessage = (role: Role, content: string, msgId?: string) => {
    setMessages((prev) => [
      ...prev,
      { id: msgId || createId(), role, content, timestamp: nowStamp() },
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
    saveSetting('elevenlabs.apiKey', elevenLabsApiKey);
  }, [elevenLabsApiKey]);

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

  useEffect(() => {
    return () => {
      streamAbortRef.current?.abort();
      void cancelAgentRun(getApiBaseUrl());
    };
  }, []);

  const handleStopAgent = () => {
    void cancelAgentRun(getApiBaseUrl());
    streamAbortRef.current?.abort();
  };

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || isRunningRef.current) {
      return;
    }
    isRunningRef.current = true;
    const streamController = new AbortController();
    streamAbortRef.current = streamController;

    if (previewAudioUrl) {
      URL.revokeObjectURL(previewAudioUrl);
      setPreviewAudioUrl(null);
    }
    setPreviewDawMessage(null);
    setPreviewDawError(null);

    setIsRunning(true);
    addMessage('user', trimmed);
    setInput('');

    let assistantIdForRun: string | undefined;
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

      const dawContext = getDawContext(syncedDocument);

      assistantIdForRun = createId();
      addMessage('assistant', '', assistantIdForRun);

      let pendingMusic: { blob: Blob; prompt: string; durationMs: number } | null = null;

      await runAgentStream(getApiBaseUrl(), {
        prompt: trimmed,
        keywords: [],
        loop: 1,
        authTokens: authTokens || undefined,
        projectUrl: projectUrlToSend,
        messages: history.length > 0 ? history : undefined,
        llmProvider,
        llmApiKey: llmApiKey.trim() || undefined,
        elevenlabsApiKey: elevenLabsApiKey.trim() || undefined,
        dawContext,
      }, async (event) => {
        if (event.type === 'reply') {
          setMessages(prev => prev.map(m => m.id === assistantIdForRun ? { ...m, content: event.data.reply } : m));

          const gm = event.data.generated_music;
          if (gm?.audio_base64) {
            const blob = new Blob(
              [Uint8Array.from(atob(gm.audio_base64), (c) => c.charCodeAt(0))],
              { type: 'audio/mpeg' },
            );
            const url = URL.createObjectURL(blob);
            setPreviewAudioUrl(url);
            pendingMusic = { blob, prompt: gm.prompt, durationMs: gm.music_length_ms ?? 15000 };
          }
        } else if (event.type === 'trace' || event.type === 'trace_update') {
          setMessages(prev => prev.map(m => {
            if (m.id === assistantIdForRun) {
              const traces = [...(m.traces || [])];
              const existing = traces.findIndex(t => t.id === event.data.id);
              if (existing >= 0) {
                traces[existing] = { ...traces[existing], ...event.data };
              } else {
                traces.push(event.data);
              }
              return { ...m, traces };
            }
            return m;
          }));
        } else if (event.type === 'error') {
          setMessages(prev => prev.map(m => m.id === assistantIdForRun ? { ...m, content: event.data.error } : m));
        }
      }, { signal: streamController.signal });

      if (pendingMusic) {
        const { blob, prompt, durationMs } = pendingMusic;
        if (client && syncedDocument && projectStatus === 'connected') {
          setPreviewDawMessage('Uploading sample and adding to timeline…');
          try {
            const idx = audioImportLayoutRef.current++;
            await importAudioBlobToProject(client, syncedDocument, blob, {
              displayName: `ElevenLabs: ${String(prompt).slice(0, 80)}`,
              durationMs,
              layoutIndex: idx,
            });
            setPreviewDawMessage('Added to your Audiotool project (audio track + region).');
            setPreviewDawError(null);
          } catch (dawErr) {
            setPreviewDawMessage(null);
            setPreviewDawError(
              `Could not add to DAW: ${formatError(dawErr)}. The preview below still plays locally.`,
            );
          }
        } else {
          setPreviewDawMessage(
            'Connect an Audiotool project (sidebar) to place this clip on the timeline automatically.',
          );
        }
      }
    } catch (error) {
      const isAbort =
        (typeof DOMException !== 'undefined' && error instanceof DOMException && error.name === 'AbortError') ||
        (error instanceof Error && error.name === 'AbortError');
      if (isAbort && assistantIdForRun) {
        setMessages(prev =>
          prev.map(m =>
            m.id === assistantIdForRun && !m.content
              ? { ...m, content: 'Stopped.' }
              : m,
          ),
        );
      } else if (!isAbort) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        setMessages(prev =>
          prev.map(m =>
            m.role === 'assistant' && !m.content ? { ...m, content: `Error: ${message}` } : m,
          ),
        );
      }
    } finally {
      streamAbortRef.current = null;
      isRunningRef.current = false;
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
    <div
      className="page animate-in"
      onAnimationEnd={(e) => {
        if (e.animationName === 'fadeIn') {
          e.currentTarget.classList.remove('animate-in');
        }
      }}
    >
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
                ref={cogwheelRef}
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
                  <p>
                    Start the conversation by sending a message. You can paste ABC notation, ask the agent to add
                    instruments, or describe music you want generated (ElevenLabs)&mdash;for example: &quot;Generate 15 seconds of
                    chill lo-fi beats, instrumental.&quot;
                  </p>
                </div>
              ) : (
                messages.map((message) => (
                  <div
                    key={message.id}
                    className={`message ${message.role} animate-in`}
                    onAnimationEnd={(e) => {
                      if (e.animationName === 'floatIn') {
                        e.currentTarget.classList.remove('animate-in');
                      }
                    }}
                  >
                    <div className="message-meta">
                      <span className="role">{message.role}</span>
                      {showTimestamps && <span className="time">{message.timestamp}</span>}
                    </div>
                    {message.traces && message.traces.length > 0 && (
                      <div className="message-traces" style={{ fontSize: '0.85em', opacity: 0.8, marginBottom: '8px', padding: '8px', background: 'rgba(0,0,0,0.1)', borderRadius: '4px', borderLeft: '2px solid var(--accent, #666)' }}>
                        {message.traces.map(t => (
                          <div key={t.id} style={{ marginBottom: '4px' }}>
                            <span style={{ fontWeight: 'bold' }}>{t.label}</span>
                            {t.status === 'running' && <span style={{ marginLeft: 8, fontStyle: 'italic' }}>running...</span>}
                            {t.status === 'done' && <span style={{ marginLeft: 8, color: '#4caf50' }}>✓ finished</span>}
                            {t.status === 'error' && <span style={{ marginLeft: 8, color: '#f44336' }}>✗ failed</span>}
                            <div style={{ fontSize: '0.9em', opacity: 0.7, wordBreak: 'break-all' }}>{t.detail}</div>
                          </div>
                        ))}
                      </div>
                    )}
                    <p style={{ whiteSpace: 'pre-wrap' }}>{message.content || (message.role === 'assistant' && !message.traces?.length ? 'Thinking...' : '')}</p>
                  </div>
                ))
              )}
            </div>

            {previewAudioUrl && (
              <div className="music-generate-section music-agent-preview" role="region" aria-label="Generated music preview">
                {previewDawMessage && <p className="music-daw-status">{previewDawMessage}</p>}
                {previewDawError && <p className="music-error">{previewDawError}</p>}
                <div className="music-player">
                  <audio controls src={previewAudioUrl} />
                </div>
              </div>
            )}

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
              <button
                type="button"
                className="ghost"
                disabled={!isRunning}
                onClick={handleStopAgent}
              >
                Stop
              </button>
            </form>
          </main>
        </div>

        {settingsSidebarOpen && (
          <aside
            className="settings-sidebar animate-in"
            onAnimationEnd={(e) => {
              if (e.animationName === 'slideInFromRight') {
                e.currentTarget.classList.remove('animate-in');
              }
            }}
          >
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
                <div className="setting-item horizontal">
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
                <div className="setting-item horizontal">
                  <span className="setting-label">Theme</span>
                  <select
                    value={theme}
                    onChange={(e) => setTheme(e.target.value)}
                    className="theme-select"
                    aria-label="Color theme"
                  >
                    <option value="default">HPU</option>
                    <option value="black-red">Redliner</option>
                    <option value="ivory">Ivory</option>
                  </select>
                </div>
                <div className="setting-item horizontal">
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
                <div className="setting-item">
                  <span className="setting-label">Button Style</span>
                  <select
                    value={buttonStyle}
                    onChange={(e) => setButtonStyle(e.target.value)}
                    className="theme-select"
                    aria-label="Button style"
                  >
                    <option value="filled">Filled</option>
                    <option value="outlined">Outlined</option>
                    <option value="minimal">Minimal</option>
                    <option value="ghost">Ghost</option>
                    <option value="flat">Flat</option>
                  </select>
                </div>
              </div>

              <div className="settings-section">
                <h4>Accessibility</h4>
                <div className="setting-item horizontal">
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
                  <span className="setting-label">Dyslexia-Fonts</span>
                  <select
                    value={dyslexiaFont}
                    onChange={(e) => setDyslexiaFont(e.target.value)}
                    className="theme-select"
                    aria-label="Dyslexia-friendly fonts"
                  >
                    <option value="default">Default</option>
                    <option value="atkinson">Atkinson Hyperlegible</option>
                    <option value="lexend">Lexend</option>
                  </select>
                </div>
                <div className="setting-item">
                  <span className="setting-label">Colorblind Themes</span>
                  <select
                    value={colorblindnessTheme}
                    onChange={(e) => setColorblindnessTheme(e.target.value)}
                    className="theme-select"
                    aria-label="Colorblindness theme"
                  >
                    <option value="none">None</option>
                    <option value="deuteranopia">Deuteranopia (Green-blind)</option>
                    <option value="protanopia">Protanopia (Red-blind)</option>
                    <option value="tritanopia">Tritanopia (Blue-blind)</option>
                  </select>
                </div>
              </div>

              <div className="settings-section">
                <h4>User Preferences</h4>
                <div className="setting-item horizontal">
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
                <div className="setting-item horizontal">
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
                <div className="setting-item horizontal">
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
                <div className="setting-item horizontal">
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
                <h4>Developer Settings</h4>
                <div className="setting-item horizontal">
                  <span className="setting-label">Provider</span>
                  <select
                    value={llmProvider}
                    onChange={(e) => setLlmProvider(e.target.value as LLMProvider)}
                    className="theme-select"
                    aria-label="LLM provider"
                  >
                    <option value="gemini">Gemini (Google)</option>
                    <option value="anthropic">Anthropic (Claude)</option>
                    <option value="openai">OpenAI (GPT)</option>
                  </select>
                </div>
                <div className="setting-item">
                  <span className="setting-label">LLM API Key</span>
                  <input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => setLlmApiKey(e.target.value)}
                    placeholder="Enter your LLM API key"
                    className="api-key-input"
                    aria-label="API key for LLM provider"
                    autoComplete="off"
                  />
                </div>
                <div className="setting-item">
                  <span className="setting-label">ElevenLabs API Key</span>
                  <input
                    type="password"
                    value={elevenLabsApiKey}
                    onChange={(e) => setElevenLabsApiKey(e.target.value)}
                    placeholder="Enter your ElevenLabs API key"
                    className="api-key-input"
                    aria-label="ElevenLabs API key for music generation in chat"
                    autoComplete="off"
                  />
                </div>
              </div>

            </div>
          </aside>
        )}
      </div>

      {tutorialStep > 0 && tutorialStep <= tutorialSteps.length && (
        <div
          className="tutorial-overlay animate-in"
          onClick={skipTutorial}
          onAnimationEnd={(e) => {
            if (e.animationName === 'fadeIn') {
              e.currentTarget.classList.remove('animate-in');
            }
          }}
        >
          <div
            className={`tutorial-modal arrow-${tutorialStep === 1 ? 'left' : tutorialStep === 2 ? 'bottom' : 'right'}`}
            onClick={(e) => e.stopPropagation()}
            style={{
              ...(tutorialStep === 1 ? { left: 'calc(var(--sidebar-w) + 20px)', top: '200px' } :
                tutorialStep === 2 ? { left: 'calc(50vw - 175px)', top: 'calc(50vh - 10px)' } :
                  tutorialStep === 3 ? { right: cogwheelPos.right, top: cogwheelPos.top } : {})
            }}
          >
            <h2>{tutorialSteps[tutorialStep - 1].title}</h2>
            <p>{tutorialSteps[tutorialStep - 1].text}</p>
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center' }}>
              {tutorialStep > 1 && (
                <button onClick={prevTutorialStep}>Back</button>
              )}
              {tutorialStep < tutorialSteps.length && (
                <button onClick={skipTutorial}>Skip</button>
              )}
              <button onClick={nextTutorialStep}>
                {tutorialStep === tutorialSteps.length ? 'Finish' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
