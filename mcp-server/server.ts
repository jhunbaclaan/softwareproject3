// required imports
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import abcjs from "abcjs";
import {
  getLoginStatus,
  createAudiotoolClient,
  SyncedDocument,
} from "@audiotool/nexus";
import { TokenManager } from "./token-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Gakki preset UUIDs by GM instrument name (lowercase, underscores). Loaded from gakki-instruments.json. */
let gakkiByGmName: Record<string, string> = {};
try {
  const gakkiPath = join(__dirname, "..", "gakki-instruments.json");
  const data = JSON.parse(readFileSync(gakkiPath, "utf-8"));
  gakkiByGmName = data.by_gm_name ?? {};
} catch {
  // Fallback if file missing; Gakki will use default preset
}

// creating server instance
const server = new McpServer({
  name: "nexus-mcp-server",
  version: "1.0.0",
});

// client, document reference, and token manager
let audiotoolClient: Awaited<ReturnType<typeof createAudiotoolClient>> | null =
  null;
let document: SyncedDocument | null = null;
let tokenManager: TokenManager | null = null;

// auto-layout counter so entities placed without coordinates don't stack
let autoLayoutOffset = 0;

const VALID_ENTITY_TYPES = [
  "audioMerger", "audioSplitter", "autoFilter", "bandSplitter",
  "bassline", "beatbox8", "beatbox9", "centroid", "crossfader", "curve", "exciter",
  "gakki", "graphicalEQ", "gravity", "heisenberg", "helmholtz", "kobolt", "machiniste",
  "matrixArpeggiator", "minimixer", "noteSplitter", "panorama", "pulsar", "pulverisateur",
  "quantum", "quasar", "rasselbock", "ringModulator", "space", "stereoEnhancer",
  "stompboxChorus", "stompboxCompressor", "stompboxCrusher", "stompboxDelay",
  "stompboxFlanger", "stompboxGate", "stompboxParametricEqualizer", "stompboxPhaser",
  "stompboxPitchDelay", "stompboxReverb", "stompboxSlope", "stompboxStereoDetune",
  "stompboxTube", "tinyGain", "tonematrix", "waveshaper", "notetrack",
  "mixerChannel", "mixerMaster", "mixerGroup", "mixerAux", "mixerReverbAux", "mixerDelayAux"
] as const;

const ENTITY_TYPE_ALIASES: Record<string, string> = {
  machinedrum: "machiniste",
  "drum machine": "machiniste",
  drummachine: "machiniste",
  "808": "beatbox8",
  "909": "beatbox9",
  chorus: "stompboxChorus",
  compressor: "stompboxCompressor",
  crusher: "stompboxCrusher",
  delay: "stompboxDelay",
  flanger: "stompboxFlanger",
  gate: "stompboxGate",
  eq: "graphicalEQ",
  phaser: "stompboxPhaser",
  "pitch delay": "stompboxPitchDelay",
  reverb: "stompboxReverb",
  slope: "stompboxSlope",
  detune: "stompboxStereoDetune",
  tube: "stompboxTube",
  sampler: "space",
  modular: "pulverisateur",
  "fm synth": "pulsar"
};

/** Instruments that can play note tracks (NoteTrackPlayer). Used for add-abc-track. */
const NOTE_TRACK_INSTRUMENTS = [
  "heisenberg", "bassline", "space", "gakki", "pulverisateur",
  "tonematrix", "machiniste", "matrixArpeggiator", "pulsar",
  "kobolt", "beatbox8", "beatbox9", "centroid", "rasselbock"
] as const;

const INSTRUMENT_ALIASES: Record<string, string> = {
  synth: "heisenberg",
  "poly synth": "heisenberg",
  pad: "heisenberg",
  lead: "heisenberg",
  bass: "bassline",
  "bass synth": "bassline",
  acid: "bassline",
  sampler: "space",
  rompler: "space",
  strings: "gakki",
  "string synth": "gakki",
  drums: "machiniste",
  "drum machine": "machiniste",
  sequencer: "tonematrix",
  "step sequencer": "tonematrix",
  arpeggiator: "matrixArpeggiator",
  matrix: "matrixArpeggiator",
  // Gakki has French horn and other orchestral sounds
  "french horn": "gakki",
  horn: "gakki",
  trumpet: "gakki",
  trombone: "gakki",
  brass: "gakki",
  woodwind: "heisenberg",
  flute: "heisenberg",
  oboe: "heisenberg",
  "808": "beatbox8",
  "909": "beatbox9",
  modular: "pulverisateur",
  fm: "pulsar"
};

/** Audiotool ticks: 1 whole note = 15360, 1 quarter = 3840 */
const TICKS_WHOLE = 15360;
const TICKS_QUARTER = 3840;

/**
 * Parse ABC notation and extract notes using abcjs.
 * Returns { pitch, positionTicks, durationTicks, velocity }.
 * Uses tune.setUpAudio() which returns tracks with events (start/duration in whole-note units).
 */
function parseAbcToNotes(abcString: string): Array<{ pitch: number; positionTicks: number; durationTicks: number; velocity: number }> {
  const notes: Array<{ pitch: number; positionTicks: number; durationTicks: number; velocity: number }> = [];
  try {
    const tuneObjs = abcjs.parseOnly(abcString.trim());
    if (!tuneObjs || tuneObjs.length < 1) {
      throw new Error("No tune found in ABC notation");
    }
    const tuneObj = tuneObjs[0] as { setUpAudio?: (opts?: object) => { tracks?: Array<Array<{ cmd?: string; pitch?: number; start?: number; duration?: number; volume?: number }>> } };
    const audio = tuneObj?.setUpAudio?.({});
    if (!audio?.tracks) {
      throw new Error("Could not extract sequence from ABC");
    }
    for (const track of audio.tracks) {
      if (!Array.isArray(track)) continue;
      for (const ev of track) {
        if (ev.cmd === "note" && ev.pitch != null) {
          const start = ev.start ?? 0;
          const duration = ev.duration ?? 0.25;
          const positionTicks = Math.round(start * TICKS_WHOLE);
          const durationTicks = Math.max(TICKS_QUARTER / 4, Math.round(duration * TICKS_WHOLE));
          const velocity = ev.volume != null ? Math.min(1, Math.max(0, ev.volume / 127)) : 0.7;
          notes.push({
            pitch: Math.max(0, Math.min(127, ev.pitch)),
            positionTicks,
            durationTicks,
            velocity,
          });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ABC notation: ${msg}`);
  }
  return notes.sort((a, b) => a.positionTicks - b.positionTicks);
}

function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Resolve a user-supplied entity type to a valid one via:
 * 1. exact match, 2. case-insensitive match, 3. Levenshtein fuzzy match (max distance 3).
 * Returns the resolved type or null if nothing is close enough.
 */
function resolveEntityType(input: string): string | null {
  const trimmed = input.trim();
  if (VALID_ENTITY_TYPES.includes(trimmed as any)) return trimmed;

  const lower = trimmed.toLowerCase();

  if (ENTITY_TYPE_ALIASES[lower]) return ENTITY_TYPE_ALIASES[lower];

  const ciMatch = VALID_ENTITY_TYPES.find((t) => t.toLowerCase() === lower);
  if (ciMatch) return ciMatch;

  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of VALID_ENTITY_TYPES) {
    const d = levenshtein(lower, t.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 3 ? best : null;
}

/**
 * Resolve user-supplied instrument name to a valid NoteTrackPlayer type.
 * Uses aliases and fuzzy matching.
 */
function resolveInstrumentType(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (NOTE_TRACK_INSTRUMENTS.includes(trimmed as any)) return trimmed;
  if (INSTRUMENT_ALIASES[trimmed]) return INSTRUMENT_ALIASES[trimmed];
  const ciMatch = NOTE_TRACK_INSTRUMENTS.find((t) => t.toLowerCase() === trimmed);
  if (ciMatch) return ciMatch;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of NOTE_TRACK_INSTRUMENTS) {
    const d = levenshtein(trimmed, t.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 3 ? best : null;
}

/** Short names / LLM outputs → keys in gakki-instruments.json by_gm_name */
const GAKKI_NAME_SYNONYMS: Record<string, string> = {
  horn: "french_horn",
  brass: "brass_section",
  strings: "string_ensemble_1",
  string: "string_ensemble_1",
  orchestral: "string_ensemble_1",
  symphonic: "string_ensemble_1",
};

/**
 * Resolve an instrument name (e.g. "french horn", "trumpet") to a Gakki preset UUID.
 * Uses gakki-instruments.json by_gm_name. Returns undefined if not found.
 */
function resolveGakkiPresetUuid(instrumentName: string): string | undefined {
  const key = instrumentName
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[()]/g, "");
  const direct = gakkiByGmName[key];
  if (direct) return direct;
  const syn = GAKKI_NAME_SYNONYMS[key];
  return syn ? gakkiByGmName[syn] : undefined;
}

/** Match user/ABC text to GM keys (order: multi-word phrases before single words like "horn"). */
const GAKKI_TEXT_PATTERNS: ReadonlyArray<{ pattern: RegExp; gmKey: string }> = [
  { pattern: /\bfrench\s+horn\b/i, gmKey: "french_horn" },
  { pattern: /\benglish\s+horn\b/i, gmKey: "english_horn" },
  { pattern: /\bmuted\s+trumpet\b/i, gmKey: "muted_trumpet" },
  { pattern: /\bbrass\s+section\b/i, gmKey: "brass_section" },
  { pattern: /\bstring\s+ensemble\s*2\b/i, gmKey: "string_ensemble_2" },
  { pattern: /\bstring\s+ensemble\s*1\b/i, gmKey: "string_ensemble_1" },
  { pattern: /\btrumpet\b/i, gmKey: "trumpet" },
  { pattern: /\btrombone\b/i, gmKey: "trombone" },
  { pattern: /\btuba\b/i, gmKey: "tuba" },
  { pattern: /\bviolin\b/i, gmKey: "violin" },
  { pattern: /\bviola\b/i, gmKey: "viola" },
  { pattern: /\bcello\b/i, gmKey: "cello" },
  { pattern: /\bcontrabass\b/i, gmKey: "contrabass" },
  { pattern: /\bflute\b/i, gmKey: "flute" },
  { pattern: /\bpiccolo\b/i, gmKey: "piccolo" },
  { pattern: /\boboe\b/i, gmKey: "oboe" },
  { pattern: /\bclarinet\b/i, gmKey: "clarinet" },
  { pattern: /\bbassoon\b/i, gmKey: "bassoon" },
  { pattern: /\bhorn\b/i, gmKey: "french_horn" },
  { pattern: /\bbrass\b/i, gmKey: "brass_section" },
  { pattern: /\bstrings\b/i, gmKey: "string_ensemble_1" },
];

function resolveGakkiPresetUuidFromHints(args: {
  instrument?: string;
  orchestralVoice?: string;
  abcNotation: string;
}): string | undefined {
  for (const s of [args.orchestralVoice, args.instrument]) {
    if (!s?.trim()) continue;
    const u = resolveGakkiPresetUuid(s);
    if (u) return u;
  }
  const haystack = [
    args.abcNotation,
    args.orchestralVoice ?? "",
    args.instrument ?? "",
  ].join("\n");
  for (const { pattern, gmKey } of GAKKI_TEXT_PATTERNS) {
    if (pattern.test(haystack) && gakkiByGmName[gmKey]) {
      return gakkiByGmName[gmKey];
    }
  }
  return undefined;
}

/** Entity types that produce audio and their output field name (for DesktopAudioCable fromSocket). */
const AUDIO_OUTPUT_FIELD: Record<string, string> = {
  heisenberg: "audioOutput",
  bassline: "audioOutput",
  machiniste: "mainOutput",
  tonematrix: "audioOutput",
  stompboxDelay: "audioOutput",
  space: "audioOutput",
  gakki: "audioOutput",
  pulverisateur: "audioOutput",
  matrixArpeggiator: "audioOutput",
  audioMerger: "audioOutput",
  audioSplitter: "audioOutput1",
  autoFilter: "audioOutput",
  bandSplitter: "highOutput",
  beatbox8: "mainOutput",
  beatbox9: "mainOutput",
  centroid: "audioOutput",
  crossfader: "audioOutput",
  curve: "audioOutput",
  exciter: "audioOutput",
  graphicalEQ: "audioOutput",
  gravity: "audioOutput",
  helmholtz: "audioOutput",
  kobolt: "audioOutput",
  minimixer: "mainOutput",
  panorama: "audioOutput",
  pulsar: "audioOutput",
  quantum: "audioOutput",
  quasar: "audioOutput",
  rasselbock: "audioOutput",
  ringModulator: "audioOutput",
  stereoEnhancer: "audioOutput",
  stompboxChorus: "audioOutput",
  stompboxCompressor: "audioOutput",
  stompboxCrusher: "audioOutput",
  stompboxFlanger: "audioOutput",
  stompboxGate: "audioOutput",
  stompboxParametricEqualizer: "audioOutput",
  stompboxPhaser: "audioOutput",
  stompboxPitchDelay: "audioOutput",
  stompboxReverb: "audioOutput",
  stompboxSlope: "audioOutput",
  stompboxStereoDetune: "audioOutput",
  stompboxTube: "audioOutput",
  tinyGain: "audioOutput",
  waveshaper: "audioOutput"
};

/**
 * Connect an audio device to the stagebox (mixer) by creating a DesktopAudioCable
 * from the device's output to a new MixerChannel's input.
 * Always creates a new MixerChannel so each device gets its own channel (a channel
 * input can only accept one cable).
 * Uses unique orderAmongStrips and displayName to avoid "multiple pointers" validation errors.
 */
function connectDeviceToStagebox(t: any, device: any, entityType: string): void {
  const outputFieldName = AUDIO_OUTPUT_FIELD[entityType];
  if (!outputFieldName) return;

  const outputField = (device.fields as any)[outputFieldName];
  if (!outputField?.location) return;

  // orderAmongStrips must be globally unique across all mixer strips
  const stripTypes = ["mixerChannel", "mixerGroup", "mixerAux", "mixerReverbAux", "mixerDelayAux"];
  const existingStrips = stripTypes.flatMap((type) =>
    t.entities.ofTypes(type as any).get()
  );
  const maxOrder = existingStrips.reduce((max: number, s: any) => {
    const dp = (s.fields as any).displayParameters;
    const order = dp?.fields?.orderAmongStrips?.value ?? 0;
    return Math.max(max, order);
  }, -1);
  const nextOrder = maxOrder + 1;

  const deviceDisplayName = (device.fields as any).displayName?.value ?? "";
  const channelLabel = deviceDisplayName || `${entityType} ${nextOrder}`;

  const mixerChannel = t.create("mixerChannel" as any, {});
  if (!mixerChannel) return;

  const displayParams = (mixerChannel.fields as any).displayParameters;
  if (displayParams?.fields) {
    t.update(displayParams.fields.orderAmongStrips, nextOrder);
    t.update(displayParams.fields.displayName, channelLabel);
  }

  const inputLocation = (mixerChannel.fields as any).audioInput?.location;
  if (!inputLocation) return;

  t.create("desktopAudioCable" as any, {
    fromSocket: outputField.location,
    toSocket: inputLocation,
  });
}

// helper function to set the gain of Heisenberg's Operator A
// operatorA is a NexusObject; its nested fields (e.g. gain) are at operatorA.fields
function setHeisenbergOperatorAGain(t: any, heisenberg: any, gain: number): void {
  const operatorA = (heisenberg.fields as any).operatorA;
  const gainField = operatorA?.fields?.gain;
  if (gainField) {
    t.update(gainField, gain);
  }
}

// helper for authenticated client
async function getClient() {
  if (!audiotoolClient) {
    const status = await getLoginStatus({
      clientId: process.env.AUDIOTOOL_CLIENT_ID || "",
      redirectUrl: process.env.AUDIOTOOL_REDIRECT_URL || "",
      scope: process.env.AUDIOTOOL_SCOPE || "",
    });
    // if not logged in, throws error
    if (!status.loggedIn) {
      throw new Error("User not logged in. Log into Audiotool first.");
    }
    // create client if logged in
    audiotoolClient = await createAudiotoolClient({
      authorization: status,
    });
  }

  return audiotoolClient;
}
// document helper with connection check
async function getDocument(): Promise<SyncedDocument> {
  if (!document) {
    throw new Error(
      "No document open. Use the 'initialize-session' tool to open a project first.",
    );
  }

  // Quick connection check
  // Connection is guaranteed by initialize-session, but check anyway for safety
  if (!document.connected.getValue()) {
    throw new Error(
      "Document is not connected. The connection may have been lost.",
    );
  }

  return document;
}

// define tools
// initialize session with auth tokens and project
server.registerTool(
  "initialize-session",
  {
    description:
      "Initialize authenticated session with Audiotool using provided OIDC tokens and open a project document.",
    inputSchema: z.object({
      accessToken: z.string().describe("OIDC access token"),
      expiresAt: z
        .number()
        .describe("Token expiration timestamp in milliseconds"),
      refreshToken: z.string().optional().describe("OIDC refresh token"),
      clientId: z.string().describe("Audiotool OAuth client ID"),
      redirectUrl: z.string().describe("OAuth redirect URL"),
      scope: z.string().describe("OAuth scope"),
      projectUrl: z.string().describe("URL/ID of the Audiotool project to use"),
    }),
  },
  async (args: {
    accessToken: string;
    expiresAt: number;
    refreshToken?: string;
    clientId: string;
    redirectUrl: string;
    scope: string;
    projectUrl: string;
  }) => {
    try {
      console.error("[initialize-session] Starting session initialization...");
      const {
        accessToken,
        expiresAt,
        refreshToken,
        clientId,
        redirectUrl,
        scope,
        projectUrl,
      } = args;

      console.error("[initialize-session] Received args:", {
        clientId,
        redirectUrl,
        scope,
        projectUrl,
        hasAccessToken: !!accessToken,
        accessTokenLength: accessToken?.length,
        expiresAt,
        hasRefreshToken: !!refreshToken,
      });

      // Create TokenManager for automatic token refresh
      console.error(
        "[initialize-session] Creating TokenManager for automatic token refresh...",
      );
      tokenManager = new TokenManager({
        accessToken,
        expiresAt,
        refreshToken,
        clientId,
      });

      // Use TokenManager with getToken() method for authorization
      // This allows the client to automatically refresh tokens as needed
      console.error(
        "[initialize-session] Creating Audiotool client with TokenManager...",
      );
      audiotoolClient = await createAudiotoolClient({
        authorization: tokenManager,
      });
      console.error("[initialize-session] Client created successfully!");

      // Create and start synced document
      console.error(
        "[initialize-session] Creating synced document for project:",
        projectUrl,
      );
      document = await audiotoolClient.createSyncedDocument({
        project: projectUrl,
      });
      console.error("[initialize-session] Document created, starting sync...");

      // Start document sync
      await document.start();
      console.error(
        "[initialize-session] Document sync started, waiting for connection...",
      );

      // Wait for WebSocket connection to be established
      // The start() method syncs data but connection happens asynchronously
      const waitForConnection = new Promise<void>((resolve, reject) => {
        // Check if already connected
        if (document!.connected.getValue()) {
          console.error("[initialize-session] Already connected!");
          resolve();
          return;
        }

        // Subscribe to connection changes
        const subscription = document!.connected.subscribe((isConnected) => {
          if (isConnected) {
            console.error("[initialize-session] Connection established!");
            subscription.terminate();
            resolve();
          }
        }, false); // false = don't trigger immediately with current value

        // Timeout after 10 seconds
        setTimeout(() => {
          subscription.terminate();
          reject(new Error("Connection timeout after 10 seconds"));
        }, 10000);
      });

      await waitForConnection;
      console.error("[initialize-session] Document connected and ready!");

      return {
        content: [
          {
            type: "text",
            text: `Session initialized successfully. Document synced and ready for project: ${projectUrl}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error("[initialize-session] ERROR:", errorMsg);
      // Return error as tool result instead of throwing so the server stays alive
      return {
        content: [
          {
            type: "text",
            text: `Session initialization failed: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// open document tool (kept for backward compatibility)
server.registerTool(
  "open-document",
  {
    description: "Open an Audiotool document via project URL or ID.",
    inputSchema: z.object({
      projectURL: z
        .string()
        .optional()
        .describe("URL/ID of the Audiotool project to use"),
    }),
  },
  async (args: { projectURL?: string }) => {
    try {
      const { projectURL } = args;
      console.error(`[open-document] Opening document: ${projectURL}`);

      const client = await getClient();

      document = await client.createSyncedDocument({
        project: projectURL || "",
      });
      await document.start();

      console.error(`[open-document] Document opened successfully`);

      return {
        content: [
          {
            type: "text",
            text: projectURL
              ? `Opened document for project: ${projectURL}`
              : "Project opened successfully",
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[open-document] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to open document: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);
// add entity tool
server.registerTool(
  "add-entity",
  {
    description: [
      "Add an entity (instrument or effect) to the Audiotool project.",
      "There are many entity types. Here are some examples by role:",
      "  - Synths/Generators: 'heisenberg', 'bassline', 'pulsar', 'pulverisateur', 'kobolt', 'space'",
      "  - Drums: 'machiniste', 'beatbox8', 'beatbox9'",
      "  - Logic/Sequencers: 'tonematrix', 'matrixArpeggiator'",
      "  - Effects: 'stompboxDelay', 'stompboxChorus', 'stompboxReverb', 'graphicalEQ', 'stompboxCompressor', etc.",
      "When the user describes a sound or style (e.g. 'Daft Punk', 'warm pad'), pick the most fitting entity type.",
      "Typos are tolerated (e.g. 'hisenberg' resolves to 'heisenberg').",
      "If x/y are omitted the server auto-places the entity at a default position.",
    ].join("\n"),
    inputSchema: z.object({
      entityType: z
        .string()
        .describe(
          "Type of entity to add. Examples: 'heisenberg', 'bassline', 'machiniste', 'tonematrix', 'stompboxDelay'",
        ),
      properties: z
        .record(z.string(), z.any())
        .optional()
        .describe("Properties for the entity"),
      x: z
        .number()
        .optional()
        .describe("X position (optional, auto-placed if omitted)"),
      y: z
        .number()
        .optional()
        .describe("Y position (optional, auto-placed if omitted)"),
      autoConnectToMixer: z
        .boolean()
        .optional()
        .default(true)
        .describe("Whether to automatically connect this device's output to a new mixer channel. Set to false for insert/mastering effects.")
    }),
  },
  async (args: {
    entityType: string;
    properties?: Record<string, any>;
    x?: number;
    y?: number;
    autoConnectToMixer?: boolean;
  }) => {
    try {
      const { properties } = args;
      const resolvedType = resolveEntityType(args.entityType);
      if (!resolvedType) {
        const msg = `Unknown entity type: '${args.entityType}'. Valid types: ${VALID_ENTITY_TYPES.join(", ")}`;
        console.error(`[add-entity] ${msg}`);
        throw new Error(msg);
      }
      if (resolvedType !== args.entityType) {
        console.error(
          `[add-entity] Resolved '${args.entityType}' → '${resolvedType}'`,
        );
      }

      const posX = args.x ?? autoLayoutOffset * 120;
      const posY = args.y ?? 0;
      autoLayoutOffset++;

      console.error(
        `[add-entity] Adding ${resolvedType} at (${posX}, ${posY})...`,
      );
      console.error(
        `[add-entity] Properties:`,
        JSON.stringify(properties || {}, null, 2),
      );

      const doc = await getDocument();

      const result = await doc.modify((t) => {
        try {
          const entityProperties = {
            ...(properties || {}),
            positionX: posX,
            positionY: posY,
            gain: 0.5,
            displayName: (properties?.displayName as string) ?? `${resolvedType} ${autoLayoutOffset}`,
          };

          const newEntity = t.create(resolvedType as any, entityProperties);

          if (!newEntity) {
            return {
              error: `Failed to create entity: t.create returned undefined`,
            };
          }

          if (args.autoConnectToMixer !== false) {
            connectDeviceToStagebox(t, newEntity, resolvedType);
          }
          
          if (resolvedType === "heisenberg") {
            setHeisenbergOperatorAGain(t, newEntity, 0.5);
          }

          return { entity: newEntity };
        } catch (innerError) {
          const msg =
            innerError instanceof Error
              ? innerError.message
              : String(innerError);
          return { error: msg };
        }
      });

      if ("error" in result) {
        throw new Error(result.error as string);
      }

      const entity = (result as { entity: any }).entity;
      console.error(
        `[add-entity] Successfully added ${resolvedType} with ID: ${entity?.id}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Added ${resolvedType} at position (${posX}, ${posY}). Entity ID: ${entity?.id}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;
      console.error(`[add-entity] ERROR:`, errorMsg);
      if (errorStack) {
        console.error(`[add-entity] Stack trace:`, errorStack);
      }
      return {
        content: [
          {
            type: "text",
            text: `Failed to add entity: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// add-abc-track tool
server.registerTool(
  "add-abc-track",
  {
    description: [
      "Add a note track to the Audiotool DAW from ABC notation.",
      "Parses the ABC string, creates an instrument (or uses an existing note-playing device),",
      "creates a NoteTrack, NoteCollection, NoteRegion, and adds all notes. Call this when the user",
      "provides music in ABC notation (e.g. X:1, K:C, L:1/4, CDEF GABc|).",
      "Orchestral: use instrument=french horn (etc.) or orchestralVoice; do not use instrument=gakki alone (defaults to piano).",
      "Other instruments: heisenberg, bassline, pulsar, kobolt, space, gakki, ",
      "pulverisateur, tonematrix, machiniste, beatbox8, beatbox9, matrixArpeggiator, etc.",
    ].join(" "),
    inputSchema: z.object({
      abcNotation: z
        .string()
        .describe("ABC notation string (e.g. X:1\\nK:C\\nL:1/4\\nCDEF GABc|)"),
      instrument: z
        .string()
        .optional()
        .describe(
          "Sound/device for the note player. Prefer the user's exact instrument (e.g. french horn, trumpet, violin)—not the word gakki alone, which defaults to piano. Aliases: heisenberg, bassline, space, gakki, pulverisateur, tonematrix, machiniste, matrixArpeggiator, synth, bass, strings, drums, brass, horn, etc. Default: heisenberg.",
        ),
      orchestralVoice: z
        .string()
        .optional()
        .describe(
          "If instrument is gakki or a vague alias (strings, brass, horn), set the specific orchestral voice the user asked for (e.g. french horn, trumpet). Also repeat it here if the user said it in chat so the correct Gakki preset is applied.",
        ),
      playerEntityId: z
        .string()
        .optional()
        .describe(
          "ID of existing instrument to use. If omitted, a new instrument is created based on the instrument parameter.",
        ),
      x: z.number().optional().describe("X position for new instrument (if created)"),
      y: z.number().optional().describe("Y position for new instrument (if created)"),
    }),
  },
  async (args: {
    abcNotation: string;
    instrument?: string;
    orchestralVoice?: string;
    playerEntityId?: string;
    x?: number;
    y?: number;
  }) => {
    try {
      const notes = parseAbcToNotes(args.abcNotation);
      if (notes.length === 0) {
        throw new Error("No notes found in ABC notation");
      }

      const doc = await getDocument();

      const instrumentType =
        resolveInstrumentType(args.instrument ?? "heisenberg") ?? "heisenberg";

      // Gakki: applyPresetTo with preset from API; bare "gakki" has no UUID → default piano without hints.
      let gakkiPreset: unknown | undefined = undefined;
      if (!args.playerEntityId && instrumentType === "gakki") {
        const presetUuid = resolveGakkiPresetUuidFromHints({
          instrument: args.instrument,
          orchestralVoice: args.orchestralVoice,
          abcNotation: args.abcNotation,
        });
        if (presetUuid) {
          const client = await getClient();
          gakkiPreset = await client.api.presets.get(
            `presets/${presetUuid}`,
          );
        } else {
          console.error(
            "[add-abc-track] Gakki device but no preset UUID (instrument=%s orchestralVoice=%s). Default patch may be piano.",
            args.instrument ?? "",
            args.orchestralVoice ?? "",
          );
        }
      }

      const result = await doc.modify((t) => {
        try {
          let playerLocation: { location: { id: string } };
          if (args.playerEntityId) {
            const playerEntity = t.entities.getEntity(args.playerEntityId);
            if (!playerEntity) {
              return { error: `Player entity ${args.playerEntityId} not found` };
            }
            playerLocation = playerEntity as any;
          } else {
            const posX = args.x ?? autoLayoutOffset * 120;
            const posY = args.y ?? 0;
            autoLayoutOffset++;
            const createOpts: Record<string, unknown> = {
              positionX: posX,
              positionY: posY,
              displayName: `${instrumentType} ${autoLayoutOffset}`,
            };
            const player = t.create(instrumentType as any, createOpts);
            if (!player) {
              return {
                error: `Failed to create ${instrumentType} instrument`,
              };
            }
            if (instrumentType === "gakki" && gakkiPreset !== undefined) {
              (t as any).applyPresetTo(player, gakkiPreset);
            }
            connectDeviceToStagebox(t, player, instrumentType);
            if (instrumentType === "heisenberg") {
              setHeisenbergOperatorAGain(t, player, 0.5);
            }
            playerLocation = player as any;
          }

          const existingTracks = t.entities
            .ofTypes("noteTrack" as any, "audioTrack" as any, "automationTrack" as any, "patternTrack" as any)
            .get();
          const maxTrackOrder = existingTracks.reduce((max: number, tr: any) => {
            const order = (tr.fields as any).orderAmongTracks?.value ?? 0;
            return Math.max(max, order);
          }, -1);

          const noteTrack = t.create("noteTrack" as any, {
            orderAmongTracks: maxTrackOrder + 1,
            player: playerLocation.location,
          });
          if (!noteTrack) {
            return { error: "Failed to create NoteTrack" };
          }

          const noteCollection = t.create("noteCollection" as any, {});
          if (!noteCollection) {
            return { error: "Failed to create NoteCollection" };
          }

          const lastNote = notes[notes.length - 1];
          const regionEnd =
            lastNote.positionTicks + lastNote.durationTicks;
          const regionDuration = Math.max(regionEnd, TICKS_WHOLE);

          const noteRegion = t.create("noteRegion" as any, {
            track: (noteTrack as any).location,
            collection: (noteCollection as any).location,
            region: {
              positionTicks: 0,
              durationTicks: regionDuration,
              loopDurationTicks: regionDuration,
              collectionOffsetTicks: 0,
              loopOffsetTicks: 0,
            },
          });
          if (!noteRegion) {
            return { error: "Failed to create NoteRegion" };
          }

          for (const n of notes) {
            t.create("note" as any, {
              collection: (noteCollection as any).location,
              positionTicks: n.positionTicks,
              durationTicks: n.durationTicks,
              pitch: n.pitch,
              velocity: n.velocity,
            });
          }

          return {
            noteTrackId: (noteTrack as any).id,
            noteCount: notes.length,
          };
        } catch (innerError) {
          const msg =
            innerError instanceof Error
              ? innerError.message
              : String(innerError);
          return { error: msg };
        }
      });

      if ("error" in result) {
        throw new Error(result.error as string);
      }

      const { noteTrackId, noteCount } = result as {
        noteTrackId: string;
        noteCount: number;
      };
      console.error(
        `[add-abc-track] Added track with ${noteCount} notes, track ID: ${noteTrackId}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Added ABC track with ${noteCount} notes. NoteTrack ID: ${noteTrackId}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[add-abc-track] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to add ABC track: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// remove entity tool
server.registerTool(
  "remove-entity",
  {
    description: "Remove an entity from the Audiotool project",
    inputSchema: z.object({
      entityID: z.string().describe("ID of the entity to remove"),
      removeDependencies: z
        .boolean()
        .optional()
        .default(false)
        .describe(
          "If true, then any entities that depend/are connected to this one are also removed.",
        ),
    }),
  },
  async (args: { entityID: string; removeDependencies?: boolean }) => {
    try {
      const { entityID, removeDependencies } = args;
      console.error(`[remove-entity] Removing entity ${entityID}...`);

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          if (removeDependencies) {
            t.removeWithDependencies(entityID);
          } else t.remove(entityID);
          return { ok: true };
        } catch (innerError) {
          const msg =
            innerError instanceof Error
              ? innerError.message
              : String(innerError);
          return { error: msg };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      console.error(`[remove-entity] Successfully removed entity ${entityID}`);

      return {
        content: [
          {
            type: "text",
            text: `Removed entity with ID ${entityID}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[remove-entity] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to remove entity: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);
// update entity value tool
server.registerTool(
  "update-entity-value",
  {
    description: [
      "Update an entity's parameter/field value. Use ONLY these field names:",
      "  heisenberg: gain [0-1], glideMs [0-5000], tuneSemitones [-12,12], playModeIndex [1-3], unisonoCount [1-4], unisonoDetuneSemitones [0-1], unisonoStereoSpreadFactor [-1,1], velocityFactor [0-1], operatorDetuneModeIndex [1-2], isActive (bool)",
      "  bassline: cutoffFrequencyHz [220-12000], filterDecay [0-1], filterEnvelopeModulationDepth [0-1], filterResonance [0-1], accent [0-1], gain [0-1], tuneSemitones [-12,12], waveformIndex [1-2], patternIndex [0-27], isActive (bool)",
      "  machiniste: globalModulationDepth [-1,1], mainOutputGain [0-1], patternIndex [0-31], isActive (bool)",
      "  tonematrix: patternIndex [0-7], isActive (bool)",
      "  stompboxDelay: feedbackFactor [0-1], mix [0-1], stepCount [1-7], stepLengthIndex [1-3], isActive (bool)",
      "For other entities, use the 'inspect-entity' tool first to discover the exact names of available fields and their types.",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().describe("ID of the entity to update"),
      fieldName: z
        .string()
        .describe(
          "Name of the field to update. Must be one of the valid fields listed above for the entity's type.",
        ),
      value: z.number().describe("New value for the field"),
    }),
  },
  async (args: {
    entityID: string;
    fieldName: string;
    value: string | number | boolean;
  }) => {
    try {
      const { entityID, fieldName, value } = args;
      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const entity = t.entities.getEntity(entityID);
          if (!entity) {
            return { error: `Entity with ID ${entityID} not found` };
          }

          const field = (entity.fields as any)[fieldName];
          if (!field) {
            return {
              error: `Field '${fieldName}' not found on entity ${entityID}`,
            };
          }

          t.update(field, value);
          return { ok: true };
        } catch (innerError) {
          const msg =
            innerError instanceof Error
              ? innerError.message
              : String(innerError);
          return { error: msg };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      return {
        content: [
          {
            type: "text",
            text: `Updated ${fieldName} of entity ${entityID} to ${value}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[update-entity-value] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to update entity value: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);
// update entity position tool
server.registerTool(
  "update-entity-position",
  {
    description: "Update an entity's position on the desktop",
    inputSchema: z.object({
      entityID: z.string().describe("ID of the entity to move"),
      x: z.number().describe("New X position"),
      y: z.number().describe("New Y position"),
    }),
  },
  async (args: { entityID: string; x: number; y: number }) => {
    try {
      const { entityID, x, y } = args;
      console.error(
        `[update-entity-position] Moving entity ${entityID} to (${x}, ${y})...`,
      );
      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const entity = t.entities.getEntity(entityID);
          if (!entity) {
            return { error: `Entity with ID ${entityID} not found` };
          }

          const fields = entity.fields as any;

          if (!fields.positionX || !fields.positionY) {
            return {
              error: `Entity ${entityID} does not have positionX/positionY fields`,
            };
          }

          t.update(fields.positionX, x);
          t.update(fields.positionY, y);
          return { ok: true };
        } catch (innerError) {
          const msg =
            innerError instanceof Error
              ? innerError.message
              : String(innerError);
          return { error: msg };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      console.error(
        `[update-entity-position] Successfully moved entity ${entityID} to (${x}, ${y})`,
      );
      return {
        content: [
          {
            type: "text",
            text: `Moved entity ${entityID} to position (${x}, ${y})`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[update-entity-position] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to move entity: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// inspect entity tool
server.registerTool(
  "inspect-entity",
  {
    description: "Inspect an entity to see its available fields/parameters and their current scalar values. Crucial for discovering how to tweak new entities.",
    inputSchema: z.object({
      entityID: z.string().describe("ID of the entity to inspect"),
    }),
  },
  async (args: { entityID: string }) => {
    try {
      const { entityID } = args;
      const doc = await getDocument();
      const entity = doc.queryEntities.get().find((e) => e.id === entityID);
      
      if (!entity) {
        throw new Error(`Entity with ID ${entityID} not found`);
      }

      const exportedFields: Record<string, any> = {};
      const fields = entity.fields as Record<string, any>;
      
      for (const [key, field] of Object.entries(fields)) {
        if (field && typeof field === 'object' && 'value' in field) {
          exportedFields[key] = field.value;
        } else if (field && typeof field === 'object' && 'location' in field) {
          exportedFields[key] = `[Socket/Port: ${field.location}]`;
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Entity ${entityID} (${entity.entityType}) Fields:\n${JSON.stringify(exportedFields, null, 2)}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to inspect entity: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// connect entities tool
server.registerTool(
  "connect-entities",
  {
    description: "Connect the audio/note output of one entity to the input of another. Use inspect-entity to discover the correct specific field names (like 'audioOutput' and 'audioInput').",
    inputSchema: z.object({
      sourceEntityId: z.string().describe("ID of the source entity (e.g. the synthesizer or effect outputting signal)"),
      sourceField: z.string().describe("Name of the source field (e.g. 'audioOutput' or 'mainOutput')"),
      targetEntityId: z.string().describe("ID of the target entity (e.g. an effect or mixerChannel receiving signal)"),
      targetField: z.string().describe("Name of the target field (e.g. 'audioInput' or 'audioInput1')"),
      cableType: z.string().optional().default("desktopAudioCable").describe("Type of cable to create. Default is 'desktopAudioCable'. For notes, use 'desktopNoteCable'."),
    }),
  },
  async (args) => {
    try {
      const { sourceEntityId, sourceField, targetEntityId, targetField, cableType } = args;
      const doc = await getDocument();
      
      const modifyResult = await doc.modify((t) => {
        try {
          const sourceEntity = t.entities.getEntity(sourceEntityId);
          if (!sourceEntity) return { error: `Source entity ${sourceEntityId} not found` };
          
          const targetEntity = t.entities.getEntity(targetEntityId);
          if (!targetEntity) return { error: `Target entity ${targetEntityId} not found` };
          
          const sourceSocket = (sourceEntity.fields as any)[sourceField];
          if (!sourceSocket || !sourceSocket.location) {
            return { error: `Field '${sourceField}' missing or not a socket on entity ${sourceEntityId}` };
          }
          
          const targetSocket = (targetEntity.fields as any)[targetField];
          if (!targetSocket || !targetSocket.location) {
            return { error: `Field '${targetField}' missing or not a socket on entity ${targetEntityId}` };
          }
          
          const newCable = t.create(cableType as any, {
            fromSocket: sourceSocket.location,
            toSocket: targetSocket.location
          });
          
          if (!newCable) return { error: "Failed to create cable" };
          
          return { ok: true, cableId: (newCable as any).id };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });
      
      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }
      
      return {
        content: [{ type: "text", text: `Connected ${sourceEntityId}.${sourceField} to ${targetEntityId}.${targetField} using ${cableType}. Cable ID: ${(modifyResult as any).cableId}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to connect entities: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// disconnect entities tool
server.registerTool(
  "disconnect-entities",
  {
    description: "Remove a cable connection between entities using its cable ID. Use list-entities or inspect-entity beforehand to find cable endpoints if needed, though they are usually reported when created.",
    inputSchema: z.object({
      cableId: z.string().describe("ID of the cable entity to remove"),
    }),
  },
  async (args: { cableId: string }) => {
    try {
      const { cableId } = args;
      const doc = await getDocument();
      
      const modifyResult = await doc.modify((t) => {
        try {
          t.remove(cableId);
          return { ok: true };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });
      
      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }
      
      return {
        content: [
          {
            type: "text",
            text: `Successfully disconnected cable ${cableId}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to disconnect cable: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// list entities tool
server.registerTool(
  "list-entities",
  {
    description: [
      "List all user-created entities (instruments and effects) in the project.",
      "Returns each entity's ID, type, and current position (x, y).",
      "Use this tool to discover what is in the project before moving, organizing, or removing entities.",
    ].join(" "),
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const doc = await getDocument();
      const validSet = new Set<string>(VALID_ENTITY_TYPES);
      const allEntities = doc.queryEntities
        .get()
        .filter((e) => validSet.has(e.entityType));

      const result = allEntities.map((e) => {
        const fields = e.fields as any;
        return {
          id: e.id,
          type: e.entityType,
          positionX: fields.positionX?.value ?? null,
          positionY: fields.positionY?.value ?? null,
        };
      });

      console.error(`[list-entities] Found ${result.length} entities`);
      return {
        content: [
          {
            type: "text",
            text:
              result.length > 0
                ? JSON.stringify(result, null, 2)
                : "No entities found in the project.",
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[list-entities] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to list entities: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// recommend-entity-for-style tool
const STYLE_MAP: Record<string, { entityType: string; reason: string }> = {
  // genre / artist keywords → best entity
  bass: {
    entityType: "bassline",
    reason: "Bass-heavy sound is best served by the bassline monophonic synth.",
  },
  acid: {
    entityType: "bassline",
    reason: "Acid sounds (303-style) map to the bassline synth.",
  },
  sub: {
    entityType: "bassline",
    reason: "Sub-bass frequencies are the domain of the bassline synth.",
  },
  "daft punk": {
    entityType: "bassline",
    reason: "Daft Punk frequently uses monophonic synth bass lines.",
  },
  techno: {
    entityType: "machiniste",
    reason: "Techno is driven by drum machine patterns.",
  },
  drum: {
    entityType: "machiniste",
    reason: "Drum / beat requests map to the machiniste drum machine.",
  },
  beat: {
    entityType: "machiniste",
    reason: "Beat / rhythm requests map to the machiniste drum machine.",
  },
  percussion: {
    entityType: "machiniste",
    reason: "Percussion requests map to the machiniste drum machine.",
  },
  "hip hop": {
    entityType: "machiniste",
    reason: "Hip hop relies on drum machine beats.",
  },
  trap: {
    entityType: "machiniste",
    reason: "Trap is driven by drum machine patterns.",
  },
  pad: {
    entityType: "heisenberg",
    reason:
      "Pads and atmospheric textures map to the heisenberg polyphonic synth.",
  },
  chord: {
    entityType: "heisenberg",
    reason: "Chords need a polyphonic synth like heisenberg.",
  },
  ambient: {
    entityType: "heisenberg",
    reason: "Ambient / atmospheric sounds map to heisenberg.",
  },
  lead: {
    entityType: "heisenberg",
    reason: "Lead synth melodies map to heisenberg.",
  },
  keys: {
    entityType: "heisenberg",
    reason: "Keyboard / keys parts map to heisenberg.",
  },
  piano: {
    entityType: "heisenberg",
    reason: "Piano-like polyphonic parts map to heisenberg.",
  },
  arpeggio: {
    entityType: "tonematrix",
    reason: "Arpeggios and sequenced patterns map to the tonematrix.",
  },
  loop: {
    entityType: "tonematrix",
    reason: "Melodic loops and generative patterns map to the tonematrix.",
  },
  sequence: {
    entityType: "tonematrix",
    reason: "Step-sequenced patterns map to the tonematrix.",
  },
  delay: {
    entityType: "stompboxDelay",
    reason: "Delay / echo effects map to the stompboxDelay.",
  },
  echo: {
    entityType: "stompboxDelay",
    reason: "Echo effects map to the stompboxDelay.",
  },
  space: {
    entityType: "stompboxDelay",
    reason: "Spacey / spatial effects map to the stompboxDelay.",
  },
  reverb: {
    entityType: "stompboxDelay",
    reason:
      "Reverb-like spatial effects can be approximated with stompboxDelay.",
  },
};

function recommendEntityForStyle(description: string): {
  entityType: string;
  reason: string;
} {
  const lower = description.toLowerCase();
  for (const [keyword, rec] of Object.entries(STYLE_MAP)) {
    if (lower.includes(keyword)) return rec;
  }
  return {
    entityType: "heisenberg",
    reason:
      "Heisenberg is the most versatile synth and a good default for unrecognised styles.",
  };
}

server.registerTool(
  "recommend-entity-for-style",
  {
    description: [
      "Given a free-text style description (artist name, genre, adjective, or sound description),",
      "recommend the best Audiotool entity type to achieve that sound.",
      "Returns the suggested entityType and a short reason.",
      "Call this BEFORE add-entity when the user describes a sound but does not name a specific entity type.",
    ].join(" "),
    inputSchema: z.object({
      description: z
        .string()
        .describe(
          "Free-text style description, e.g. 'Daft Punk', 'warm bass', 'ambient pads', 'techno beat'",
        ),
    }),
  },
  async (args: { description: string }) => {
    const rec = recommendEntityForStyle(args.description);
    console.error(
      `[recommend-entity-for-style] '${args.description}' → ${rec.entityType} (${rec.reason})`,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(rec),
        },
      ],
    };
  },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);
