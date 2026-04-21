import { useEffect, useMemo, useRef, useState } from 'react';
import {
  audiotool,
  type AudiotoolClient,
  type SyncedDocument,
} from '@audiotool/nexus';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import './App.css';
import { cancelAgentRun, getApiBaseUrl, runAgentStream, type ConversationMessage, type LLMProvider, type TraceItem, type DawContext } from './api';
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
const sidebarWidthStorageKey = 'ui.sidebarWidth';
const defaultSidebarWidth = 300;
const minSidebarWidth = 240;
const maxSidebarWidth = 520;

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

type ChatIndexEntry = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  userRenamed?: boolean;
  projectName?: string;
  projectDisplayName?: string;
  projectUrl?: string;
};

type StoredMessage = {
  id: string;
  role: Role;
  content: string;
  timestamp: string;
};

type StoredChat = ChatIndexEntry & { messages: StoredMessage[] };
type AudiotoolAuth = Awaited<ReturnType<typeof audiotool>>;

const chatHistoryIndexKey = 'chatHistory.index';
const chatHistoryCurrentKey = 'chatHistory.currentId';
const chatHistoryChatKeyPrefix = 'chatHistory.chat.';

const loadChatIndex = (): ChatIndexEntry[] => {
  if (typeof window === 'undefined') {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(chatHistoryIndexKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (e): e is ChatIndexEntry =>
        e && typeof e.id === 'string' && typeof e.title === 'string',
    );
  } catch {
    return [];
  }
};

const saveChatIndex = (index: ChatIndexEntry[]) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(chatHistoryIndexKey, JSON.stringify(index));
  } catch {
    /* quota exceeded or serialization error - ignore */
  }
};

const loadStoredChat = (id: string): StoredChat | null => {
  if (typeof window === 'undefined' || !id) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(chatHistoryChatKeyPrefix + id);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== 'string' || !Array.isArray(parsed.messages)) {
      return null;
    }
    return parsed as StoredChat;
  } catch {
    return null;
  }
};

const saveStoredChat = (chat: StoredChat) => {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(
      chatHistoryChatKeyPrefix + chat.id,
      JSON.stringify(chat),
    );
  } catch {
    /* quota exceeded - ignore */
  }
};

const deleteStoredChat = (id: string) => {
  if (typeof window === 'undefined' || !id) {
    return;
  }
  window.localStorage.removeItem(chatHistoryChatKeyPrefix + id);
};

const loadCurrentChatId = (): string | null => {
  if (typeof window === 'undefined') {
    return null;
  }
  return window.localStorage.getItem(chatHistoryCurrentKey);
};

const saveCurrentChatId = (id: string | null) => {
  if (typeof window === 'undefined') {
    return;
  }
  if (id) {
    window.localStorage.setItem(chatHistoryCurrentKey, id);
  } else {
    window.localStorage.removeItem(chatHistoryCurrentKey);
  }
};

const deriveChatTitle = (messages: Pick<Message, 'role' | 'content'>[]): string => {
  const firstUser = messages.find((m) => m.role === 'user' && m.content.trim());
  if (firstUser) {
    const text = firstUser.content.trim().replace(/\s+/g, ' ');
    return text.length > 48 ? `${text.slice(0, 48).trimEnd()}…` : text;
  }
  return `Chat ${new Date().toLocaleString()}`;
};

const formatError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const clampSidebarWidth = (width: number) =>
  Math.min(maxSidebarWidth, Math.max(minSidebarWidth, width));

const extractProjectId = (name: string) => name.replace(/^projects\//, '');

const getStudioUrl = (projectName: string) =>
  `https://beta.audiotool.com/studio?project=${extractProjectId(projectName)}`;

/**
 * Accepts only an Audiotool studio URL that includes ?project=...
 * Returns the API resource name and the normalized studio URL used for sync.
 */
function parseAudiotoolProjectRef(raw: string): { resourceName: string; studioUrl: string } | null {
  const t = raw.trim();
  if (!t) {
    return null;
  }

  try {
    const u = new URL(t);
    const projectId = u.searchParams.get('project')?.trim();
    if (!projectId) {
      return null;
    }
    const host = u.hostname.toLowerCase();
    if (!host.endsWith('audiotool.com')) {
      return null;
    }
    const resourceName = `projects/${projectId}`;
    return { resourceName, studioUrl: getStudioUrl(resourceName) };
  } catch {
    return null;
  }
}

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
  const [authStatus, setAuthStatus] = useState<AudiotoolAuth | null>(null);
  const [authUser, setAuthUser] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isCheckingAuth, setIsCheckingAuth] = useState(false);
  const [client, setClient] = useState<AudiotoolClient | null>(null);
  const [projectUrl, setProjectUrl] = useState(
    loadSetting('audiotool.projectUrl', ''),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const savedWidth = parseInt(loadSetting(sidebarWidthStorageKey, `${defaultSidebarWidth}`), 10);
    return Number.isFinite(savedWidth) ? clampSidebarWidth(savedWidth) : defaultSidebarWidth;
  });
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
  const [projectSearchQuery, setProjectSearchQuery] = useState('');
  const [projectManageError, setProjectManageError] = useState<string | null>(null);
  const [renamingProjectName, setRenamingProjectName] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [renameSavingFor, setRenameSavingFor] = useState<string | null>(null);
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

  const [chatIndex, setChatIndex] = useState<ChatIndexEntry[]>(() => loadChatIndex());
  const [currentChatId, setCurrentChatId] = useState<string | null>(() => {
    const id = loadCurrentChatId();
    if (!id) return null;
    return loadStoredChat(id) ? id : null;
  });
  const [chatDrawerOpen, setChatDrawerOpen] = useState<boolean>(
    () => loadSetting('ui.chatDrawerOpen', 'false') === 'true',
  );
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [renamingChatId, setRenamingChatId] = useState<string | null>(null);
  const [chatRenameDraft, setChatRenameDraft] = useState('');
  const [reconnectPrompt, setReconnectPrompt] = useState<{
    chatId: string;
    projectName: string;
    projectDisplayName: string;
    projectUrl: string;
    projectMissing: boolean;
  } | null>(null);
  const hydratedFromCurrentRef = useRef(false);
  const saveDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipNextSaveRef = useRef(false);

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
    saveSetting(sidebarWidthStorageKey, `${sidebarWidth}`);
  }, [sidebarWidth]);

  useEffect(() => {
    saveSetting('ui.chatDrawerOpen', chatDrawerOpen ? 'true' : 'false');
  }, [chatDrawerOpen]);

  useEffect(() => {
    if (hydratedFromCurrentRef.current) {
      return;
    }
    hydratedFromCurrentRef.current = true;
    const id = loadCurrentChatId();
    if (!id) return;
    const stored = loadStoredChat(id);
    if (!stored) {
      saveCurrentChatId(null);
      return;
    }
    const hydrated: Message[] = stored.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));
    skipNextSaveRef.current = true;
    setMessages(hydrated);
    setCurrentChatId(stored.id);
  }, []);

  useEffect(() => {
    if (!hydratedFromCurrentRef.current) {
      return;
    }
    if (messages.length === 0) {
      return;
    }
    if (skipNextSaveRef.current) {
      skipNextSaveRef.current = false;
      return;
    }
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
    }
    saveDebounceRef.current = setTimeout(() => {
      setCurrentChatId((existingId) => {
        const id = existingId ?? createId();
        const now = Date.now();
        const storedMessages: StoredMessage[] = messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          timestamp: m.timestamp,
        }));

        const connectedProject = projectList.find((p) => p.name === connectedProjectName);
        const projectName =
          projectStatus === 'connected' && connectedProjectName
            ? connectedProjectName
            : undefined;
        const projectDisplayName = connectedProject?.displayName;
        const projectUrlForChat =
          projectStatus === 'connected' && projectUrl.trim() ? projectUrl.trim() : undefined;

        setChatIndex((prev) => {
          const existing = prev.find((e) => e.id === id);
          const userRenamed = existing?.userRenamed === true;
          const title = userRenamed ? existing!.title : deriveChatTitle(messages);
          const createdAt = existing?.createdAt ?? now;

          const entry: ChatIndexEntry = {
            id,
            title,
            createdAt,
            updatedAt: now,
            userRenamed: userRenamed || undefined,
            projectName,
            projectDisplayName,
            projectUrl: projectUrlForChat,
          };

          const stored: StoredChat = { ...entry, messages: storedMessages };
          saveStoredChat(stored);

          const next = existing
            ? prev.map((e) => (e.id === id ? entry : e))
            : [entry, ...prev];
          saveChatIndex(next);
          return next;
        });

        if (existingId !== id) {
          saveCurrentChatId(id);
        }
        return id;
      });
    }, 400);

    return () => {
      if (saveDebounceRef.current) {
        clearTimeout(saveDebounceRef.current);
      }
    };
  }, [messages, connectedProjectName, projectUrl, projectStatus, projectList]);

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
      const response = await currentClient.projects.listProjects({
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
      setProjectSearchQuery('');
      setProjectManageError(null);
      setRenamingProjectName(null);
      setRenameDraft('');
      setRenameSavingFor(null);
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
      const status = await audiotool({
        clientId: authConfig.clientId.trim(),
        redirectUrl: authConfig.redirectUrl.trim(),
        scope: authConfig.scope.trim(),
      });
      setAuthStatus(status);

      if (status.status === 'authenticated') {
        setAuthUser(status.userName ?? null);
        setClient(status);
      } else {
        setAuthUser(null);
        setClient(null);
        setSyncedDocument(null);
        setProjectStatus('idle');
        if ('error' in status && status.error) {
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
    if (status && status.status === 'unauthenticated') {
      await status.login();
    }
  };

  const handleLogout = () => {
    if (authStatus && authStatus.status === 'authenticated') {
      authStatus.logout();
    }
  };

  const connectSyncedDocument = async (
    studioUrl: string,
    projectResourceName: string,
    options: { preserveMessages?: boolean } = {},
  ) => {
    if (!client) {
      setProjectError('Login first to create a synced document.');
      setProjectStatus('error');
      return;
    }

    setProjectUrl(studioUrl);
    setConnectedProjectName(projectResourceName);
    setProjectStatus('connecting');
    setProjectError(null);
    if (!options.preserveMessages) {
      setMessages([]);
    }
    try {
      if (syncedDocument) {
        await syncedDocument.stop();
      }
      const doc = await client.open(studioUrl);
      await doc.start();
      setSyncedDocument(doc);
      setProjectStatus('connected');
    } catch (error) {
      setProjectError(formatError(error));
      setProjectStatus('error');
      setConnectedProjectName(null);
    }
  };

  const handleConnectToProject = async (projectName: string) => {
    await connectSyncedDocument(getStudioUrl(projectName), projectName);
  };

  const handleConnectFromProjectUrlField = async () => {
    const parsed = parseAudiotoolProjectRef(projectUrl);
    if (!parsed) {
      setProjectError(
        'Enter a valid Audiotool project URL with ?project=... (for example: https://beta.audiotool.com/studio?project=...).',
      );
      return;
    }
    await connectSyncedDocument(parsed.studioUrl, parsed.resourceName);
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
      const response = await client.projects.createProject({
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
      const authTokens = authStatus?.status === 'authenticated'
        ? {
          ...authStatus.exportTokens(),
          clientId: authConfig.clientId.trim(),
        }
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

  const handleNewChat = () => {
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    setMessages([]);
    setCurrentChatId(null);
    saveCurrentChatId(null);
    setRenamingChatId(null);
    setChatRenameDraft('');
  };

  const handleLoadChat = (entry: ChatIndexEntry) => {
    const stored = loadStoredChat(entry.id);
    if (!stored) {
      setChatIndex((prev) => {
        const next = prev.filter((e) => e.id !== entry.id);
        saveChatIndex(next);
        return next;
      });
      return;
    }
    if (saveDebounceRef.current) {
      clearTimeout(saveDebounceRef.current);
      saveDebounceRef.current = null;
    }
    const hydrated: Message[] = stored.messages.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }));
    skipNextSaveRef.current = true;
    setMessages(hydrated);
    setCurrentChatId(stored.id);
    saveCurrentChatId(stored.id);

    if (stored.projectName) {
      const alreadyConnected =
        projectStatus === 'connected' && connectedProjectName === stored.projectName;
      if (!alreadyConnected) {
        const match = projectList.find((p) => p.name === stored.projectName);
        const projectMissing = !match && !projectListToken && !projectListLoading;
        const displayName =
          match?.displayName
          ?? stored.projectDisplayName
          ?? extractProjectId(stored.projectName);
        const url = stored.projectUrl ?? getStudioUrl(stored.projectName);
        setReconnectPrompt({
          chatId: stored.id,
          projectName: stored.projectName,
          projectDisplayName: displayName,
          projectUrl: url,
          projectMissing,
        });
      }
    }
  };

  const handleReconnectConfirm = async () => {
    if (!reconnectPrompt) return;
    const { projectUrl: url, projectName } = reconnectPrompt;
    setReconnectPrompt(null);
    await connectSyncedDocument(url, projectName, { preserveMessages: true });
  };

  const handleReconnectSkip = () => {
    setReconnectPrompt(null);
  };

  const beginRenameChat = (entry: ChatIndexEntry) => {
    setRenamingChatId(entry.id);
    setChatRenameDraft(entry.title);
  };

  const cancelRenameChat = () => {
    setRenamingChatId(null);
    setChatRenameDraft('');
  };

  const handleRenameChatSave = () => {
    if (!renamingChatId) return;
    const trimmed = chatRenameDraft.trim();
    if (!trimmed) {
      cancelRenameChat();
      return;
    }
    setChatIndex((prev) => {
      const next = prev.map((e) =>
        e.id === renamingChatId
          ? { ...e, title: trimmed, userRenamed: true, updatedAt: Date.now() }
          : e,
      );
      saveChatIndex(next);
      const stored = loadStoredChat(renamingChatId);
      if (stored) {
        const updated: StoredChat = {
          ...stored,
          title: trimmed,
          userRenamed: true,
          updatedAt: Date.now(),
        };
        saveStoredChat(updated);
      }
      return next;
    });
    cancelRenameChat();
  };

  const handleDeleteChat = (entry: ChatIndexEntry) => {
    const ok = window.confirm(`Delete chat "${entry.title}"? This cannot be undone.`);
    if (!ok) return;
    deleteStoredChat(entry.id);
    setChatIndex((prev) => {
      const next = prev.filter((e) => e.id !== entry.id);
      saveChatIndex(next);
      return next;
    });
    if (currentChatId === entry.id) {
      if (saveDebounceRef.current) {
        clearTimeout(saveDebounceRef.current);
        saveDebounceRef.current = null;
      }
      setMessages([]);
      setCurrentChatId(null);
      saveCurrentChatId(null);
    }
    if (renamingChatId === entry.id) {
      cancelRenameChat();
    }
  };

  const filteredChatIndex = useMemo(() => {
    const sorted = [...chatIndex].sort((a, b) => b.updatedAt - a.updatedAt);
    const q = chatSearchQuery.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (e) =>
        e.title.toLowerCase().includes(q)
        || (e.projectDisplayName?.toLowerCase().includes(q) ?? false),
    );
  }, [chatIndex, chatSearchQuery]);

  const formatRelativeTime = (ms: number): string => {
    const diff = Date.now() - ms;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 7) return `${days}d ago`;
    return new Date(ms).toLocaleDateString();
  };

  const authPillClass = `status-pill ${authStatus?.status === 'authenticated' ? 'ok' : 'warn'}`;
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

  const filteredProjectList = useMemo(() => {
    const q = projectSearchQuery.trim().toLowerCase();
    if (!q) {
      return projectList;
    }
    return projectList.filter(
      (p) =>
        p.displayName.toLowerCase().includes(q)
        || extractProjectId(p.name).toLowerCase().includes(q),
    );
  }, [projectList, projectSearchQuery]);
  const canConnectProjectUrl = useMemo(
    () => !!parseAudiotoolProjectRef(projectUrl),
    [projectUrl],
  );

  const beginRenameProject = (project: ProjectItem) => {
    setProjectManageError(null);
    setRenamingProjectName(project.name);
    setRenameDraft(project.displayName);
  };

  const cancelRenameProject = () => {
    setRenamingProjectName(null);
    setRenameDraft('');
    setRenameSavingFor(null);
  };

  const handleRenameSave = async () => {
    if (!client || !renamingProjectName) {
      return;
    }
    const trimmed = renameDraft.trim();
    if (!trimmed) {
      setProjectManageError('Project name cannot be empty.');
      return;
    }
    setRenameSavingFor(renamingProjectName);
    setProjectManageError(null);
    try {
      const response = await client.projects.updateProject({
        project: { name: renamingProjectName, displayName: trimmed },
        updateMask: { paths: ['display_name'] },
      });
      if (response instanceof Error) {
        throw response;
      }
      setProjectList((prev) =>
        prev.map((p) =>
          p.name === renamingProjectName ? { ...p, displayName: trimmed } : p,
        ),
      );
      cancelRenameProject();
    } catch (error) {
      setProjectManageError(formatError(error));
      setRenameSavingFor(null);
    }
  };

  const handleDeleteProject = async (project: ProjectItem) => {
    if (!client) {
      return;
    }
    const ok = window.confirm(
      `Delete project "${project.displayName}"? This cannot be undone.`,
    );
    if (!ok) {
      return;
    }
    setProjectManageError(null);
    try {
      const deletingConnectedProject = connectedProjectName === project.name;
      if (syncedDocument && deletingConnectedProject) {
        try {
          await syncedDocument.stop();
        } catch {
          /* ignore stop errors; attempt delete anyway */
        }
        setSyncedDocument(null);
        setProjectStatus('idle');
        setConnectedProjectName(null);
      }

      const response = await client.projects.deleteProject({
        name: project.name,
      });
      if (response instanceof Error) {
        throw response;
      }
      if (projectUrl.trim() === getStudioUrl(project.name)) {
        setProjectUrl('');
      }
      setProjectList((prev) => prev.filter((p) => p.name !== project.name));
      if (renamingProjectName === project.name) {
        cancelRenameProject();
      }
    } catch (error) {
      setProjectManageError(formatError(error));
    }
  };

  const handleSidebarResizeStart = (event: React.PointerEvent<HTMLDivElement>) => {
    if (window.innerWidth <= 768) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidth;
    document.body.classList.add('resizing-sidebar');

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX;
      setSidebarWidth(clampSidebarWidth(startWidth + delta));
    };

    const handleEnd = () => {
      document.body.classList.remove('resizing-sidebar');
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleEnd);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleEnd);
  };

  const handleSidebarResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setSidebarWidth((prev) => clampSidebarWidth(prev - 12));
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      setSidebarWidth((prev) => clampSidebarWidth(prev + 12));
    }
  };

  return (
    <div
      className="page animate-in"
      onAnimationEnd={(e) => {
        if (e.animationName === 'fadeIn') {
          e.currentTarget.classList.remove('animate-in');
        }
      }}
    >
      <div className="app-layout" style={{ ['--sidebar-w' as string]: `${sidebarWidth}px` }}>
        <aside className="sidebar">
          <div className="sidebar-brand">
            <p className="eyebrow">Nexus Agent</p>
            <h1>Console</h1>
          </div>

          <div className="sidebar-auth">
            <div className="sidebar-auth-status">
              <span className={authPillClass}>
                {authStatus?.status === 'authenticated' ? 'Logged in' : 'Logged out'}
              </span>
              {authStatus?.status === 'authenticated' && authUser && (
                <span className="sidebar-user">{authUser}</span>
              )}
            </div>
            <div className="sidebar-auth-actions">
              <button type="button" className="ghost small" onClick={fetchLoginStatus} disabled={isCheckingAuth}>
                {isCheckingAuth ? 'Checking...' : 'Check'}
              </button>
              {authStatus?.status === 'authenticated' ? (
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
                <div className="project-url-connect">
                  <label className="project-url-connect-label" htmlFor="sidebar-project-url">
                    Connect by URL
                  </label>
                  <p className="hint project-url-connect-hint">
                    Paste a project URL.
                  </p>
                  <div className="project-url-connect-row">
                    <input
                      id="sidebar-project-url"
                      type="text"
                      className="project-url-connect-input"
                      placeholder="https://beta.audiotool.com/studio?project=…"
                      value={projectUrl}
                      onChange={(e) => setProjectUrl(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          if (canConnectProjectUrl) {
                            void handleConnectFromProjectUrlField();
                          }
                        }
                      }}
                      aria-label="Audiotool project URL"
                    />
                    <button
                      type="button"
                      className="tiny project-url-connect-btn"
                      onClick={() => void handleConnectFromProjectUrlField()}
                      disabled={projectStatus === 'connecting' || !canConnectProjectUrl}
                    >
                      Connect
                    </button>
                  </div>
                </div>

                <h4 className="project-list-heading">Projects</h4>

                <input
                  type="search"
                  className="project-search-input"
                  placeholder="Search projects…"
                  value={projectSearchQuery}
                  onChange={(e) => setProjectSearchQuery(e.target.value)}
                  aria-label="Search projects"
                />

                {projectManageError && (
                  <div className="sidebar-error">{projectManageError}</div>
                )}

                {projectListError && (
                  <div className="sidebar-error">{projectListError}</div>
                )}

                <div className="project-list-scroll">
                  {projectListLoading && projectList.length === 0 ? (
                    <p className="hint centered">Loading...</p>
                  ) : filteredProjectList.length === 0 && !projectListError ? (
                    <p className="hint centered">
                      {projectList.length === 0 ? 'No projects yet.' : 'No projects match your search.'}
                    </p>
                  ) : (
                    <div className="project-list">
                      {filteredProjectList.map((project) => {
                        const active = isActiveProject(project);
                        const isRenaming = renamingProjectName === project.name;
                        return (
                          <div
                            key={project.name}
                            className={`project-list-item${active ? ' active' : ''}`}
                          >
                            {isRenaming ? (
                              <div className="project-list-item-rename">
                                <input
                                  type="text"
                                  className="project-rename-input"
                                  value={renameDraft}
                                  onChange={(e) => setRenameDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === 'Escape') {
                                      e.preventDefault();
                                      cancelRenameProject();
                                    }
                                    if (e.key === 'Enter') {
                                      e.preventDefault();
                                      void handleRenameSave();
                                    }
                                  }}
                                  disabled={renameSavingFor === project.name}
                                  aria-label="New project name"
                                />
                                <div className="project-list-item-rename-actions">
                                  <button
                                    type="button"
                                    className="tiny"
                                    onClick={() => void handleRenameSave()}
                                    disabled={renameSavingFor === project.name}
                                  >
                                    {renameSavingFor === project.name ? 'Saving…' : 'Save'}
                                  </button>
                                  <button
                                    type="button"
                                    className="ghost tiny"
                                    onClick={cancelRenameProject}
                                    disabled={renameSavingFor === project.name}
                                  >
                                    Cancel
                                  </button>
                                </div>
                              </div>
                            ) : (
                              <>
                                <div className="project-list-item-body">
                                  <span className="project-list-item-name" title={project.displayName}>
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
                                    <button
                                      type="button"
                                      className="ghost tiny"
                                      onClick={() => beginRenameProject(project)}
                                      disabled={projectStatus === 'connecting'}
                                    >
                                      Rename
                                    </button>
                                    <button
                                      type="button"
                                      className="ghost tiny project-delete-btn"
                                      onClick={() => void handleDeleteProject(project)}
                                      disabled={projectStatus === 'connecting'}
                                    >
                                      Delete
                                    </button>
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
                              </>
                            )}
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
        <div
          className="sidebar-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize console width"
          aria-valuemin={minSidebarWidth}
          aria-valuemax={maxSidebarWidth}
          aria-valuenow={sidebarWidth}
          tabIndex={0}
          onPointerDown={handleSidebarResizeStart}
          onKeyDown={handleSidebarResizeKeyDown}
        />

        {chatDrawerOpen && (
          <aside
            className="chat-history-drawer animate-in"
            onAnimationEnd={(e) => {
              if (e.animationName === 'slideInFromLeft') {
                e.currentTarget.classList.remove('animate-in');
              }
            }}
          >
            <div className="chat-history-header">
              <h3>Chats</h3>
              <div className="chat-history-header-actions">
                <button type="button" className="tiny" onClick={handleNewChat}>
                  New
                </button>
                <button
                  type="button"
                  className="close-btn"
                  onClick={() => setChatDrawerOpen(false)}
                  aria-label="Close chat history"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="chat-history-content">
              <input
                type="search"
                className="project-search-input"
                placeholder="Search chats…"
                value={chatSearchQuery}
                onChange={(e) => setChatSearchQuery(e.target.value)}
                aria-label="Search chats"
              />
              <div className="chat-list-scroll">
                {filteredChatIndex.length === 0 ? (
                  <p className="hint centered">
                    {chatIndex.length === 0
                      ? 'No chats yet. Start typing to create one.'
                      : 'No chats match your search.'}
                  </p>
                ) : (
                  <div className="chat-list">
                    {filteredChatIndex.map((entry) => {
                      const active = currentChatId === entry.id;
                      const isRenaming = renamingChatId === entry.id;
                      return (
                        <div
                          key={entry.id}
                          className={`chat-list-item${active ? ' active' : ''}`}
                        >
                          {isRenaming ? (
                            <div className="chat-list-item-rename">
                              <input
                                type="text"
                                className="project-rename-input"
                                value={chatRenameDraft}
                                onChange={(e) => setChatRenameDraft(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    e.preventDefault();
                                    cancelRenameChat();
                                  }
                                  if (e.key === 'Enter') {
                                    e.preventDefault();
                                    handleRenameChatSave();
                                  }
                                }}
                                autoFocus
                                aria-label="New chat title"
                              />
                              <div className="project-list-item-rename-actions">
                                <button
                                  type="button"
                                  className="tiny"
                                  onClick={handleRenameChatSave}
                                >
                                  Save
                                </button>
                                <button
                                  type="button"
                                  className="ghost tiny"
                                  onClick={cancelRenameChat}
                                >
                                  Cancel
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <button
                                type="button"
                                className="chat-list-item-main"
                                onClick={() => handleLoadChat(entry)}
                                title={entry.title}
                              >
                                <span className="chat-list-item-title">{entry.title}</span>
                                <span className="chat-list-item-meta">
                                  {formatRelativeTime(entry.updatedAt)}
                                  {entry.projectDisplayName && (
                                    <span className="chat-list-item-project" title={entry.projectDisplayName}>
                                      · {entry.projectDisplayName}
                                    </span>
                                  )}
                                </span>
                              </button>
                              <div className="chat-list-item-actions">
                                <button
                                  type="button"
                                  className="ghost tiny"
                                  onClick={() => beginRenameChat(entry)}
                                  title="Rename chat"
                                >
                                  Rename
                                </button>
                                <button
                                  type="button"
                                  className="ghost tiny project-delete-btn"
                                  onClick={() => handleDeleteChat(entry)}
                                  title="Delete chat"
                                >
                                  Delete
                                </button>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </aside>
        )}

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
              <button
                type="button"
                className={`ghost small${chatDrawerOpen ? ' active' : ''}`}
                onClick={() => setChatDrawerOpen((v) => !v)}
                aria-pressed={chatDrawerOpen}
                aria-label="Toggle chat history"
                title="Chat history"
              >
                History
              </button>
              <button type="button" className="ghost small" onClick={handleNewChat}>
                New chat
              </button>
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
                    {message.content ? (
                      <div className="message-content">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {message.content}
                        </ReactMarkdown>
                      </div>
                    ) : (
                      <p className="message-content">
                        {message.role === 'assistant' && !message.traces?.length ? 'Thinking...' : ''}
                      </p>
                    )}
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
                  <span className="setting-label">Fonts</span>
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
                <h4>API Settings</h4>
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

      {reconnectPrompt && (
        <div
          className="tutorial-overlay animate-in"
          onClick={handleReconnectSkip}
          onAnimationEnd={(e) => {
            if (e.animationName === 'fadeIn') {
              e.currentTarget.classList.remove('animate-in');
            }
          }}
        >
          <div
            className="tutorial-modal reconnect-modal"
            onClick={(e) => e.stopPropagation()}
            style={{ left: 'calc(50vw - 200px)', top: 'calc(50vh - 120px)', maxWidth: 400 }}
          >
            <div className="tutorial-header">
              <span className="tutorial-step-spacer"></span>
              <h2>Reconnect to project?</h2>
              <span className="tutorial-step-spacer"></span>
            </div>
            <p>
              This chat was previously connected to{' '}
              <strong>{reconnectPrompt.projectDisplayName}</strong>.
              {projectStatus === 'connected' && connectedProjectName
                ? " You're currently connected to a different project."
                : ''}
            </p>
            {reconnectPrompt.projectMissing && (
              <p className="music-error" style={{ marginTop: 0 }}>
                Warning: this project may no longer exist in your account.
              </p>
            )}
            {!client && (
              <p className="hint centered">Log in first to reconnect.</p>
            )}
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'center', marginTop: 12 }}>
              <button type="button" className="ghost" onClick={handleReconnectSkip}>
                Skip
              </button>
              <button
                type="button"
                onClick={() => void handleReconnectConfirm()}
                disabled={!client || projectStatus === 'connecting'}
              >
                {reconnectPrompt.projectMissing ? 'Try anyway' : 'Reconnect'}
              </button>
            </div>
          </div>
        </div>
      )}

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
            <div className="tutorial-header">
              <span className="tutorial-step-spacer"></span>
              <h2>{tutorialSteps[tutorialStep - 1].title}</h2>
              <span className="tutorial-step-indicator">{tutorialStep} of {tutorialSteps.length}</span>
            </div>
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
