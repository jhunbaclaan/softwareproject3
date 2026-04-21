// required imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { getHeapStatistics } from "node:v8";
import {
  audiotool,
  type AudiotoolClient,
  createServerAuth,
  createAudiotoolClient,
  SyncedDocument,
} from "@audiotool/nexus";
import {
  createNodeTransport,
  createDiskWasmLoader,
} from "@audiotool/nexus/node";
import {
  VALID_ENTITY_TYPES,
  ENTITY_TYPE_ALIASES,
  NOTE_TRACK_INSTRUMENTS,
  INSTRUMENT_ALIASES,
  AUDIO_OUTPUT_FIELD,
  TICKS_WHOLE,
  TICKS_QUARTER,
  STYLE_MAP,
  levenshtein,
  resolveEntityType,
  resolveInstrumentType,
  resolveGakkiPresetUuid,
  resolveGakkiPresetUuidFromHints,
  parseAbcToNotes,
  normalizeAbcNotation,
  notesToAbc,
  connectDeviceToStagebox,
  setHeisenbergOperatorAGain,
  recommendEntityForStyle,
  refId,
} from "./server-utils.js";

// ---------------------------------------------------------------------------
// Active session — at most one at a time.  Each session owns its own
// McpServer + StreamableHTTPServerTransport so the SDK's one-transport-per-
// server constraint is satisfied.
// ---------------------------------------------------------------------------

interface ActiveSession {
  id: string;
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  lastActivityAtMs: number;
}

let activeSession: ActiveSession | null = null;

function createMcpServer(): McpServer {
  return new McpServer({
    name: "nexus-mcp-server",
    version: "1.0.0",
  });
}

// Placeholder: the single top-level `server` reference is only used for stdio
// mode.  In HTTP mode, per-session servers are created via createMcpServer().
let server: McpServer = createMcpServer();

// client and document reference
let audiotoolClient: AudiotoolClient | null = null;
let document: SyncedDocument | null = null;

// auto-layout counter so entities placed without coordinates don't stack
let autoLayoutOffset = 0;

interface TerminableLike {
  terminate: () => void;
}

interface DocumentEventCounters {
  created: number;
  removed: number;
  createdByType: Map<string, number>;
  removedByType: Map<string, number>;
  startedAtMs: number;
}

let documentEventCounters: DocumentEventCounters | null = null;
let documentEventSubscriptions: TerminableLike[] = [];
let memoryHeartbeatInterval: NodeJS.Timeout | null = null;
let sessionIdleTimer: NodeJS.Timeout | null = null;
let lastDeepMemDiagAtMs = 0;

const MB = 1024 * 1024;

function toMb(bytes: number): number {
  return Math.round(bytes / MB);
}

function getDocumentConnectedState(): boolean | null {
  if (!document) return null;
  try {
    return document.connected.getValue();
  } catch {
    return null;
  }
}

function summarizeTopCounters(
  counters: Map<string, number>,
  limit = 4,
): string {
  const entries = [...counters.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);
  if (entries.length === 0) return "none";
  return entries.map(([type, count]) => `${type}:${count}`).join(",");
}

function summarizeActiveResources(limit = 8): string {
  const getResourcesInfo = (
    process as unknown as { getActiveResourcesInfo?: () => string[] }
  ).getActiveResourcesInfo;
  if (typeof getResourcesInfo !== "function") return "unavailable";
  const resources = getResourcesInfo();
  if (!resources.length) return "none";

  const counts = new Map<string, number>();
  for (const resource of resources) {
    counts.set(resource, (counts.get(resource) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, count]) => `${name}:${count}`)
    .join(",");
}

function terminateDocumentEventDiagnostics(): void {
  for (const subscription of documentEventSubscriptions) {
    try {
      subscription.terminate();
    } catch (e) {
      console.error("[mcp-mem] Error terminating document diagnostic subscription:", e);
    }
  }
  documentEventSubscriptions = [];
  documentEventCounters = null;
}

function setupDocumentEventDiagnostics(doc: SyncedDocument): void {
  terminateDocumentEventDiagnostics();
  documentEventCounters = {
    created: 0,
    removed: 0,
    createdByType: new Map<string, number>(),
    removedByType: new Map<string, number>(),
    startedAtMs: Date.now(),
  };

  const createSubscription = doc.events.onCreate("*", (entity) => {
    if (!documentEventCounters) return;
    documentEventCounters.created += 1;
    const entityType = (entity as { type?: string }).type || "unknown";
    documentEventCounters.createdByType.set(
      entityType,
      (documentEventCounters.createdByType.get(entityType) || 0) + 1,
    );
  });

  const removeSubscription = doc.events.onRemove("*", (entity) => {
    if (!documentEventCounters) return;
    documentEventCounters.removed += 1;
    const entityType = (entity as { type?: string }).type || "unknown";
    documentEventCounters.removedByType.set(
      entityType,
      (documentEventCounters.removedByType.get(entityType) || 0) + 1,
    );
  });

  const connectedSubscription = doc.connected.subscribe((isConnected) => {
    logMemoryDiag("document-connected-change", {
      connected: isConnected,
      docCreates: documentEventCounters?.created ?? 0,
      docRemoves: documentEventCounters?.removed ?? 0,
    });
  }, false);

  documentEventSubscriptions.push(createSubscription, removeSubscription, connectedSubscription);
  console.error("[mcp-mem] Document event diagnostics enabled");
}

function memoryDiagString(): string {
  const mem = process.memoryUsage();
  const heapStats = getHeapStatistics();
  return [
    `rss=${toMb(mem.rss)}MB`,
    `heapUsed=${toMb(mem.heapUsed)}MB`,
    `heapTotal=${toMb(mem.heapTotal)}MB`,
    `heapLimit=${toMb(heapStats.heap_size_limit)}MB`,
    `external=${toMb(mem.external)}MB`,
    `arrayBuffers=${toMb(mem.arrayBuffers)}MB`,
    `uptime=${Math.round(process.uptime())}s`,
  ].join(" ");
}

function logMemoryDiag(
  label: string,
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const extras = Object.entries(extra)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
  const suffix = extras ? ` ${extras}` : "";
  console.error(`[mcp-mem] ${label} ${memoryDiagString()}${suffix}`);
}

function logDeepMemoryDiag(
  label: string,
  extra: Record<string, string | number | boolean | null | undefined> = {},
): void {
  const heapStats = getHeapStatistics();
  const resources = process.resourceUsage();
  const sessionUptimeSeconds = documentEventCounters
    ? Math.round((Date.now() - documentEventCounters.startedAtMs) / 1000)
    : null;

  logMemoryDiag(label, {
    ...extra,
    activeSession: activeSession?.id || "none",
    hasDocument: Boolean(document),
    connected: getDocumentConnectedState(),
    activeResources: summarizeActiveResources(),
    docCreates: documentEventCounters?.created ?? 0,
    docRemoves: documentEventCounters?.removed ?? 0,
    docCreateTop: documentEventCounters
      ? summarizeTopCounters(documentEventCounters.createdByType)
      : "none",
    docRemoveTop: documentEventCounters
      ? summarizeTopCounters(documentEventCounters.removedByType)
      : "none",
    docSessionAgeSec: sessionUptimeSeconds,
    maxRssKb: resources.maxRSS,
    userCpuUs: resources.userCPUTime,
    systemCpuUs: resources.systemCPUTime,
    totalHeapMb: toMb(heapStats.total_heap_size),
    totalPhysMb: toMb(heapStats.total_physical_size),
    availHeapMb: toMb(heapStats.total_available_size),
  });
}

function ensureMemoryHeartbeat(): void {
  if (memoryHeartbeatInterval) return;

  const intervalMsRaw = Number(process.env.MCP_MEM_HEARTBEAT_MS || 15000);
  const intervalMs = Number.isFinite(intervalMsRaw)
    ? Math.max(1000, intervalMsRaw)
    : 15000;
  const deepThresholdRaw = Number(process.env.MCP_MEM_DEEP_THRESHOLD_MB || 1200);
  const deepThresholdMb = Number.isFinite(deepThresholdRaw)
    ? Math.max(0, deepThresholdRaw)
    : 1200;
  const deepCooldownRaw = Number(process.env.MCP_MEM_DEEP_COOLDOWN_MS || 60000);
  const deepCooldownMs = Number.isFinite(deepCooldownRaw)
    ? Math.max(10000, deepCooldownRaw)
    : 60000;

  memoryHeartbeatInterval = setInterval(() => {
    const rssMb = toMb(process.memoryUsage().rss);
    logMemoryDiag("heartbeat", {
      activeSession: activeSession?.id || "none",
      hasDocument: Boolean(document),
      connected: getDocumentConnectedState(),
      activeResources: summarizeActiveResources(),
      docCreates: documentEventCounters?.created ?? 0,
      docRemoves: documentEventCounters?.removed ?? 0,
      docCreateTop: documentEventCounters
        ? summarizeTopCounters(documentEventCounters.createdByType, 3)
        : "none",
      docRemoveTop: documentEventCounters
        ? summarizeTopCounters(documentEventCounters.removedByType, 3)
        : "none",
    });

    if (deepThresholdMb > 0 && rssMb >= deepThresholdMb) {
      const now = Date.now();
      if (now - lastDeepMemDiagAtMs >= deepCooldownMs) {
        lastDeepMemDiagAtMs = now;
        logDeepMemoryDiag("heartbeat-threshold", {
          rssMb,
          thresholdMb: deepThresholdMb,
        });
      }
    }
  }, intervalMs);

  memoryHeartbeatInterval.unref?.();
  console.error(
    `[mcp-mem] Heartbeat enabled intervalMs=${intervalMs} deepThresholdMb=${deepThresholdMb} deepCooldownMs=${deepCooldownMs}`,
  );
}

function stopMemoryHeartbeat(): void {
  if (!memoryHeartbeatInterval) return;
  clearInterval(memoryHeartbeatInterval);
  memoryHeartbeatInterval = null;
}

function clearSessionIdleTimer(): void {
  if (!sessionIdleTimer) return;
  clearTimeout(sessionIdleTimer);
  sessionIdleTimer = null;
}

/**
 * Properly tear down the current session: stop the synced document (which
 * closes its WebSocket and lets Node GC the instance), then clear all
 * global references so a fresh session can be created.
 *
 * SyncedDocument.stop() **must** be called before the document is thrown
 * away — not doing so leaks the sync process and WebSocket connection.
 */
async function cleanupCurrentSession(): Promise<void> {
  logMemoryDiag("cleanup-start", {
    hasDocument: Boolean(document),
    hasClient: Boolean(audiotoolClient),
    hasDocumentDiagnostics: Boolean(documentEventCounters),
  });
  terminateDocumentEventDiagnostics();
  let documentStopTimedOut = false;
  if (document) {
    const stopTimeoutMsRaw = Number(process.env.MCP_DOCUMENT_STOP_TIMEOUT_MS || 3000);
    const stopTimeoutMs = Number.isFinite(stopTimeoutMsRaw)
      ? Math.max(500, stopTimeoutMsRaw)
      : 3000;
    try {
      await Promise.race([
        document.stop(),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("document.stop() timed out")), stopTimeoutMs),
        ),
      ]);
      console.error("[cleanup] Previous document stopped");
      logMemoryDiag("cleanup-after-stop");
    } catch (e) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      documentStopTimedOut = errorMsg.includes("document.stop() timed out");
      console.error("[cleanup] Error stopping document:", e);
      if (documentStopTimedOut) {
        logDeepMemoryDiag("cleanup-document-stop-timeout", { stopTimeoutMs });
      }
    }
    document = null;
  }
  audiotoolClient = null;
  autoLayoutOffset = 0;
  logMemoryDiag("cleanup-complete");

  if (documentStopTimedOut) {
    const failFastOnTimeout =
      (process.env.MCP_FAIL_FAST_ON_STOP_TIMEOUT || "0").trim().toLowerCase() === "1";
    if (failFastOnTimeout) {
      const exitCodeRaw = Number(process.env.MCP_FAIL_FAST_EXIT_CODE || 86);
      const exitCode = Number.isFinite(exitCodeRaw)
        ? Math.max(1, Math.floor(exitCodeRaw))
        : 86;
      console.error(
        `[cleanup] document.stop() timed out; fail-fast enabled, exiting process with code ${exitCode}`,
      );
      setTimeout(() => process.exit(exitCode), 0);
    } else {
      console.error(
        "[cleanup] document.stop() timed out; fail-fast disabled (set MCP_FAIL_FAST_ON_STOP_TIMEOUT=1 to auto-restart)",
      );
    }
  }
}

// helper for authenticated client
async function getClient() {
  if (!audiotoolClient) {
    const at = await audiotool({
      clientId: process.env.AUDIOTOOL_CLIENT_ID || "",
      redirectUrl: process.env.AUDIOTOOL_REDIRECT_URL || "",
      scope: process.env.AUDIOTOOL_SCOPE || "",
    });
    // if not logged in, throws error
    if (at.status !== "authenticated") {
      throw new Error("User not logged in. Log into Audiotool first.");
    }
    // authenticated `audiotool(...)` result is the client itself
    audiotoolClient = at;
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

// ---------------------------------------------------------------------------
// Tool registration — called once per McpServer instance.  In HTTP mode a
// fresh McpServer is created for every session, so this runs each time a new
// client connects.  In stdio mode it runs once at startup.
// ---------------------------------------------------------------------------

/**
 * Heuristic guard to confirm a field value on an entity is actually a
 * routable socket before handing it to the Nexus SDK.
 *
 * Sockets we wire cables to are NexusObject<Empty>: they have a `.location`
 * (the pointer target) and a `.fields` container, but no `.value` scalar.
 * Ordinary primitive fields (display names, modulation depths, etc.) have
 * `.value` and no `.fields`. Rejecting those here gives the agent an
 * actionable error instead of a raw SDK "pointer to field that doesn't
 * accept pointers" crash.
 */
export function isLikelySocket(field: unknown): boolean {
  if (!field || typeof field !== "object") return false;
  const f = field as Record<string, unknown>;
  return "location" in f && "fields" in f && !("value" in f);
}

function registerTools(srv: McpServer): void {

// initialize session with auth tokens and project
srv.registerTool(
  "initialize-session",
  {
    description:
      "Initialize authenticated session with Audiotool using provided OIDC tokens and open a project document.",
    inputSchema: z.object({
      accessToken: z.string().describe("OIDC access token"),
      expiresAt: z
        .number()
        .describe("Token expiration timestamp in milliseconds"),
      refreshToken: z.string().describe("OIDC refresh token"),
      clientId: z.string().describe("Audiotool OAuth client ID"),
      projectUrl: z.string().describe("URL/ID of the Audiotool project to use"),
    }),
  },
  async (args: {
    accessToken: string;
    expiresAt: number;
    refreshToken: string;
    clientId: string;
    projectUrl: string;
  }) => {
    try {
      console.error("[initialize-session] Starting session initialization...");
      logMemoryDiag("initialize-start");

      // Stop old document / client before creating new ones to avoid
      // leaking WebSocket connections and sync processes.
      await cleanupCurrentSession();
      logMemoryDiag("initialize-after-precleanup");

      const {
        accessToken,
        expiresAt,
        refreshToken,
        clientId,
        projectUrl,
      } = args;

      console.error("[initialize-session] Received args:", {
        clientId,
        projectUrl,
        hasAccessToken: !!accessToken,
        accessTokenLength: accessToken?.length,
        expiresAt,
        hasRefreshToken: !!refreshToken,
      });

      const normalizedRefreshToken = refreshToken.trim();
      if (!normalizedRefreshToken) {
        throw new Error("Missing refreshToken; initialize-session requires exported browser tokens");
      }

      console.error(
        "[initialize-session] Creating Audiotool client with createServerAuth...",
      );
      audiotoolClient = await createAudiotoolClient({
        auth: createServerAuth({
          accessToken,
          refreshToken: normalizedRefreshToken,
          expiresAt,
          clientId,
        }),
        transport: createNodeTransport(),
        wasm: createDiskWasmLoader(),
      });
      console.error("[initialize-session] Client created successfully!");
      logMemoryDiag("initialize-after-client");

      // Create and start synced document
      console.error(
        "[initialize-session] Creating synced document for project:",
        projectUrl,
      );
      document = await audiotoolClient.open(projectUrl);
      setupDocumentEventDiagnostics(document);
      console.error("[initialize-session] Document created, starting sync...");
      logMemoryDiag("initialize-after-document-created");

      // Start document sync
      await document.start();
      console.error(
        "[initialize-session] Document sync started, waiting for connection...",
      );
      logMemoryDiag("initialize-after-document-start");

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
      logMemoryDiag("initialize-connected");

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
      logMemoryDiag("initialize-error-before-cleanup");
      await cleanupCurrentSession();
      logMemoryDiag("initialize-error-after-cleanup");
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
srv.registerTool(
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

      // Reuse the same robust cleanup path as initialize-session.
      await cleanupCurrentSession();

      const client = await getClient();

      document = await client.open(projectURL || "");
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
// add entity tool (supports single or batch via optional `entities` array)
srv.registerTool(
  "add-entity",
  {
    description: [
      "Add one or more entities (instruments or effects) to the Audiotool project.",
      "SINGLE MODE: provide entityType (and optional properties/x/y/autoConnectToMixer).",
      "BATCH MODE: provide an `entities` array to create multiple entities in one call.",
      "Entity types by role:",
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
        .optional()
        .describe(
          "Type of entity to add (single mode). Examples: 'heisenberg', 'bassline', 'machiniste', 'tonematrix', 'stompboxDelay'",
        ),
      properties: z
        .record(z.string(), z.any())
        .optional()
        .describe("Properties for the entity (single mode)"),
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
        .describe("Whether to automatically connect this device's output to a new mixer channel. Set to false for insert/mastering effects."),
      entities: z.array(z.object({
        entityType: z.string().describe("Type of entity to add"),
        properties: z.record(z.string(), z.any()).optional().describe("Properties"),
        x: z.number().optional().describe("X position (optional)"),
        y: z.number().optional().describe("Y position (optional)"),
        autoConnectToMixer: z.boolean().optional().default(true).describe("Whether to automatically connect to mixer"),
      })).optional().describe("Batch mode: array of entities to create in one call. When provided, single-mode params are ignored."),
    }),
  },
  async (args: {
    entityType?: string;
    properties?: Record<string, any>;
    x?: number;
    y?: number;
    autoConnectToMixer?: boolean;
    entities?: Array<{
      entityType: string;
      properties?: Record<string, any>;
      x?: number;
      y?: number;
      autoConnectToMixer?: boolean;
    }>;
  }) => {
    try {
      const itemsToCreate: Array<{
        entityType: string;
        properties?: Record<string, any>;
        x?: number;
        y?: number;
        autoConnectToMixer?: boolean;
      }> = args.entities
        ? args.entities
        : [{
            entityType: args.entityType!,
            properties: args.properties,
            x: args.x,
            y: args.y,
            autoConnectToMixer: args.autoConnectToMixer,
          }];

      if (!itemsToCreate[0]?.entityType) {
        throw new Error("Either 'entityType' (single mode) or 'entities' array (batch mode) must be provided.");
      }

      const resolvedItems: Array<{ resolvedType: string; posX: number; posY: number; properties?: Record<string, any>; autoConnectToMixer?: boolean }> = [];
      for (const item of itemsToCreate) {
        const resolvedType = resolveEntityType(item.entityType);
        if (!resolvedType) {
          throw new Error(`Unknown entity type: '${item.entityType}'. Valid types: ${VALID_ENTITY_TYPES.join(", ")}`);
        }
        const posX = item.x ?? autoLayoutOffset * 120;
        const posY = item.y ?? 0;
        autoLayoutOffset++;
        resolvedItems.push({ resolvedType, posX, posY, properties: item.properties, autoConnectToMixer: item.autoConnectToMixer });
      }

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const entityResults: Array<{
            type: string;
            id: string;
            posX: number;
            posY: number;
            fields: Record<string, any>;
          }> = [];

          for (const item of resolvedItems) {
            const { resolvedType, posX, posY, properties } = item;
            const entityProperties = {
              ...(properties || {}),
              positionX: posX,
              positionY: posY,
              gain: 0.5,
              displayName: (properties?.displayName as string) ?? `${resolvedType} ${autoLayoutOffset}`,
            };

            const newEntity = t.create(resolvedType as any, entityProperties);
            if (!newEntity) return { error: `Failed to create entity: t.create returned undefined` };

            if (item.autoConnectToMixer !== false) {
              connectDeviceToStagebox(t, newEntity, resolvedType);
            }
            if (resolvedType === "heisenberg") {
              setHeisenbergOperatorAGain(t, newEntity, 0.5);
            }

            const exportedFields: Record<string, any> = {};
            if (newEntity.fields) {
              const fields = newEntity.fields as Record<string, any>;
              for (const [key, field] of Object.entries(fields)) {
                if (field && typeof field === 'object' && 'value' in field) {
                  exportedFields[key] = field.value;
                } else if (field && typeof field === 'object' && 'location' in field) {
                  exportedFields[key] = `[Socket/Port: ${field.location}]`;
                }
              }
            }

            entityResults.push({
              type: resolvedType,
              id: (newEntity as any).id,
              posX,
              posY,
              fields: exportedFields,
            });
          }
          return { ok: true, entities: entityResults };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      const entities = (modifyResult as { ok: true; entities: Array<{ type: string; id: string; posX: number; posY: number; fields: Record<string, any> }> }).entities;

      if (entities.length === 1) {
        const res = entities[0];
        return {
          content: [{
            type: "text",
            text: `Added ${res.type} at position (${res.posX}, ${res.posY}). Entity ID: ${res.id}\nAvailable Fields & Ports:\n${JSON.stringify(res.fields, null, 2)}`,
          }],
        };
      }

      let finalString = `Successfully added ${entities.length} entities:\n`;
      for (const res of entities) {
        finalString += `- ${res.type} at (${res.posX}, ${res.posY}). Entity ID: ${res.id}\n  Available Fields & Ports: ${JSON.stringify(res.fields)}\n`;
      }
      return { content: [{ type: "text", text: finalString }] };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[add-entity] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to add entity: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// add-abc-track tool (supports single or batch via optional `tracks` array)
srv.registerTool(
  "add-abc-track",
  {
    description: [
      "Add one or more note tracks to the Audiotool DAW from ABC notation.",
      "SINGLE MODE: provide abcNotation (and optional instrument/orchestralVoice/playerEntityId/x/y/autoConnectToMixer).",
      "BATCH MODE: provide a `tracks` array to create multiple ABC tracks in one call.",
      "Parses ABC strings, creates instruments (or uses existing note-playing devices),",
      "creates NoteTrack/NoteCollection/NoteRegion entities and adds all notes.",
      "CRITICAL: abcNotation MUST use newline-separated lines for the header (standard ABC), e.g.",
      "X:1\\nT:Title\\nM:4/4\\nK:G\\n|:GABc| — do NOT put the whole header on one line with spaces.",
      "Orchestral: use instrument=french horn (etc.) or orchestralVoice; do not use instrument=gakki alone (defaults to piano).",
      "Other instruments: heisenberg, bassline, pulsar, kobolt, space, gakki,",
      "pulverisateur, tonematrix, machiniste, beatbox8, beatbox9, matrixArpeggiator, etc.",
    ].join(" "),
    inputSchema: z.object({
      abcNotation: z
        .string()
        .optional()
        .describe("Full ABC tune string (single mode)."),
      instrument: z.string().optional().describe("Sound/device for the note player (single mode). Default: heisenberg."),
      orchestralVoice: z.string().optional().describe("Specific orchestral voice for Gakki presets (single mode)."),
      playerEntityId: z.string().optional().describe("ID of existing instrument to use (single mode)."),
      x: z.number().optional().describe("X position for new instrument (single mode)"),
      y: z.number().optional().describe("Y position for new instrument (single mode)"),
      autoConnectToMixer: z.boolean().optional().default(true).describe("Whether to auto-connect to mixer. Set false for mastering chains."),
      tracks: z.array(z.object({
        abcNotation: z.string().describe("Full ABC tune string"),
        instrument: z.string().optional().describe("Sound/device for the note player"),
        orchestralVoice: z.string().optional().describe("Specific orchestral voice for Gakki presets"),
        playerEntityId: z.string().optional().describe("ID of existing instrument to use"),
        x: z.number().optional().describe("X position for new instrument"),
        y: z.number().optional().describe("Y position for new instrument"),
        autoConnectToMixer: z.boolean().optional().default(true).describe("Whether to auto-connect to mixer"),
      })).optional().describe("Batch mode: array of ABC tracks to create in one call. When provided, single-mode params are ignored."),
    }),
  },
  async (args: {
    abcNotation?: string;
    instrument?: string;
    orchestralVoice?: string;
    playerEntityId?: string;
    x?: number;
    y?: number;
    autoConnectToMixer?: boolean;
    tracks?: Array<{
      abcNotation: string;
      instrument?: string;
      orchestralVoice?: string;
      playerEntityId?: string;
      x?: number;
      y?: number;
      autoConnectToMixer?: boolean;
    }>;
  }) => {
    try {
      const trackItems = args.tracks
        ? args.tracks
        : [{
            abcNotation: args.abcNotation!,
            instrument: args.instrument,
            orchestralVoice: args.orchestralVoice,
            playerEntityId: args.playerEntityId,
            x: args.x,
            y: args.y,
            autoConnectToMixer: args.autoConnectToMixer,
          }];

      if (!trackItems[0]?.abcNotation) {
        throw new Error("Either 'abcNotation' (single mode) or a 'tracks' array (batch mode) must be provided.");
      }

      const doc = await getDocument();

      const prepared: Array<{
        notes: Array<{ positionTicks: number; durationTicks: number; pitch: number; velocity: number }>;
        instrumentType: string;
        gakkiPreset: unknown | undefined;
        playerEntityId?: string;
        x?: number;
        y?: number;
        autoConnectToMixer?: boolean;
      }> = [];

      for (const item of trackItems) {
        const notes = parseAbcToNotes(item.abcNotation);
        if (notes.length === 0) {
          throw new Error("No notes found in ABC notation");
        }

        const instrumentType = resolveInstrumentType(item.instrument ?? "heisenberg") ?? "heisenberg";

        let gakkiPreset: unknown | undefined = undefined;
        if (!item.playerEntityId && instrumentType === "gakki") {
          const presetUuid = resolveGakkiPresetUuidFromHints({
            instrument: item.instrument,
            orchestralVoice: item.orchestralVoice,
            abcNotation: normalizeAbcNotation(item.abcNotation),
          });
          console.error(
            `[add-abc-track] gakki preset resolution: instrument=${JSON.stringify(item.instrument)}, ` +
            `orchestralVoice=${JSON.stringify(item.orchestralVoice)}, ` +
            `resolvedPresetUuid=${presetUuid ?? "none"}`
          );
          if (presetUuid) {
            const client = await getClient();
            gakkiPreset = await client.presets.get(`presets/${presetUuid}`);
            console.error(`[add-abc-track] fetched gakki preset for uuid=${presetUuid}, preset loaded=${gakkiPreset != null}`);
          } else {
            console.error(`[add-abc-track] WARNING: no gakki preset resolved — instrument will use default sound`);
          }
        }

        prepared.push({
          notes,
          instrumentType,
          gakkiPreset,
          playerEntityId: item.playerEntityId,
          x: item.x,
          y: item.y,
          autoConnectToMixer: item.autoConnectToMixer,
        });
      }

      const presetApplications: Array<{ entityId: string; preset: unknown }> = [];

      const result = await doc.modify((t) => {
        try {
          const trackResults: Array<{ noteTrackId: string; noteCount: number; playerEntityId: string }> = [];

          for (const item of prepared) {
            let playerLocation: { location: { id: string } };
            let resolvedPlayerEntityId: string;

            if (item.playerEntityId) {
              const playerEntity = t.entities.getEntity(item.playerEntityId);
              if (!playerEntity) {
                return { error: `Player entity ${item.playerEntityId} not found` };
              }
              playerLocation = playerEntity as any;
              resolvedPlayerEntityId = item.playerEntityId;
            } else {
              const posX = item.x ?? autoLayoutOffset * 120;
              const posY = item.y ?? 0;
              autoLayoutOffset++;
              const createOpts: Record<string, unknown> = {
                positionX: posX,
                positionY: posY,
                displayName: `${item.instrumentType} ${autoLayoutOffset}`,
              };
              const player = t.create(item.instrumentType as any, createOpts);
              if (!player) {
                return { error: `Failed to create ${item.instrumentType} instrument` };
              }
              if (item.instrumentType === "gakki" && item.gakkiPreset !== undefined) {
                presetApplications.push({ entityId: (player as any).id, preset: item.gakkiPreset });
              }
              if (item.autoConnectToMixer !== false) {
                connectDeviceToStagebox(t, player, item.instrumentType);
              }
              if (item.instrumentType === "heisenberg") {
                setHeisenbergOperatorAGain(t, player, 0.5);
              }
              playerLocation = player as any;
              resolvedPlayerEntityId = (player as any).id;
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
            if (!noteTrack) return { error: "Failed to create NoteTrack" };

            const noteCollection = t.create("noteCollection" as any, {});
            if (!noteCollection) return { error: "Failed to create NoteCollection" };

            const lastNote = item.notes[item.notes.length - 1];
            const regionEnd = lastNote.positionTicks + lastNote.durationTicks;
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
            if (!noteRegion) return { error: "Failed to create NoteRegion" };

            for (const n of item.notes) {
              t.create("note" as any, {
                collection: (noteCollection as any).location,
                positionTicks: n.positionTicks,
                durationTicks: n.durationTicks,
                pitch: n.pitch,
                velocity: n.velocity,
              });
            }

            trackResults.push({
              noteTrackId: (noteTrack as any).id,
              noteCount: item.notes.length,
              playerEntityId: resolvedPlayerEntityId,
            });
          }

          return { ok: true, tracks: trackResults };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if (!("error" in result) && presetApplications.length > 0) {
        console.error(`[add-abc-track] applying ${presetApplications.length} gakki preset(s) in separate transaction`);
        for (const { entityId, preset } of presetApplications) {
          await doc.modify((t) => {
            const entity = t.entities.getEntity(entityId);
            if (entity) {
              (t as any).applyPresetTo(entity, preset);
              console.error(`[add-abc-track] applied preset to gakki entity ${entityId}`);
            } else {
              console.error(`[add-abc-track] WARNING: gakki entity ${entityId} not found for preset application`);
            }
          });
        }
      }

      if ("error" in result) {
        throw new Error(result.error as string);
      }

      const tracks = (result as { ok: true; tracks: Array<{ noteTrackId: string; noteCount: number; playerEntityId: string }> }).tracks;

      if (tracks.length === 1) {
        const tr = tracks[0];
        return {
          content: [{
            type: "text",
            text: `Added ABC track with ${tr.noteCount} notes. NoteTrack ID: ${tr.noteTrackId}. Player Entity ID: ${tr.playerEntityId}`,
          }],
        };
      }

      const totalNotes = tracks.reduce((s, tr) => s + tr.noteCount, 0);
      let output = `Added ${tracks.length} ABC tracks (${totalNotes} notes total):\n`;
      for (const tr of tracks) {
        output += `- NoteTrack ID: ${tr.noteTrackId}, ${tr.noteCount} notes, Player: ${tr.playerEntityId}\n`;
      }
      return { content: [{ type: "text", text: output }] };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[add-abc-track] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to add ABC track: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// remove entity tool (supports single or batch via optional `entityIDs` array)
srv.registerTool(
  "remove-entity",
  {
    description: [
      "Remove one or more entities from the Audiotool project.",
      "SINGLE MODE: provide entityID.",
      "BATCH MODE: provide an `entityIDs` array to remove multiple entities in one call.",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().optional().describe("ID of the entity to remove (single mode)"),
      entityIDs: z.array(z.string()).optional().describe("Batch mode: array of entity IDs to remove in one call. When provided, single-mode entityID is ignored."),
      removeDependencies: z
        .boolean()
        .optional()
        .default(false)
        .describe("If true, any entities that depend on / are connected to the removed ones are also removed."),
    }),
  },
  async (args: { entityID?: string; entityIDs?: string[]; removeDependencies?: boolean }) => {
    try {
      const idsToRemove: string[] = args.entityIDs
        ? args.entityIDs
        : args.entityID ? [args.entityID] : [];

      if (idsToRemove.length === 0) {
        throw new Error("Either 'entityID' (single mode) or 'entityIDs' array (batch mode) must be provided.");
      }

      const { removeDependencies } = args;
      console.error(`[remove-entity] Removing ${idsToRemove.length} entity(s)...`);

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          for (const id of idsToRemove) {
            if (removeDependencies) {
              t.removeWithDependencies(id);
            } else {
              t.remove(id);
            }
          }
          return { ok: true };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      if (idsToRemove.length === 1) {
        return {
          content: [{ type: "text", text: `Removed entity with ID ${idsToRemove[0]}` }],
        };
      }

      return {
        content: [{ type: "text", text: `Removed ${idsToRemove.length} entities.` }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[remove-entity] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to remove entity: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);
// update entity values tool (supports single-entity or multi-entity via optional `entities` array)
srv.registerTool(
  "update-entity-values",
  {
    description: [
      "Update parameter/field values on one or more entities.",
      "SINGLE ENTITY MODE: provide entityID + updates map.",
      "MULTI-ENTITY MODE: provide an `entities` array to update fields across multiple entities in one call.",
      "Use ONLY valid field names for the entity type:",
      "  heisenberg: gain [0-1], glideMs [0-5000], tuneSemitones [-12,12], playModeIndex [1-3], unisonoCount [1-4], unisonoDetuneSemitones [0-1], unisonoStereoSpreadFactor [-1,1], velocityFactor [0-1], operatorDetuneModeIndex [1-2], isActive (bool)",
      "  bassline: cutoffFrequencyHz [220-12000], filterDecay [0-1], filterEnvelopeModulationDepth [0-1], filterResonance [0-1], accent [0-1], gain [0-1], tuneSemitones [-12,12], waveformIndex [1-2], patternIndex [0-27], isActive (bool)",
      "  machiniste: globalModulationDepth [-1,1], mainOutputGain [0-1], patternIndex [0-31], isActive (bool)",
      "  tonematrix: patternIndex [0-7], isActive (bool)",
      "  stompboxDelay: feedbackFactor [0-1], mix [0-1], stepCount [1-7], stepLengthIndex [1-3], isActive (bool)",
      "For other entities, use 'inspect-entity' or the output of 'add-entity' to discover exact field names.",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().optional().describe("ID of the entity to update (single-entity mode)"),
      updates: z.record(z.string(), z.union([z.number(), z.boolean()])).optional().describe("Map of field names to new values (single-entity mode). e.g. {'gain': 0.5, 'mix': 0.8, 'isActive': false}"),
      entities: z.array(z.object({
        entityID: z.string().describe("ID of the entity to update"),
        updates: z.record(z.string(), z.union([z.number(), z.boolean()])).describe("Map of field names to new values"),
      })).optional().describe("Multi-entity mode: array of {entityID, updates} objects. When provided, single-mode params are ignored."),
    }),
  },
  async (args: {
    entityID?: string;
    updates?: Record<string, number | boolean>;
    entities?: Array<{ entityID: string; updates: Record<string, number | boolean> }>;
  }) => {
    try {
      const updatesList: Array<{ entityID: string; updates: Record<string, number | boolean> }> = args.entities
        ? args.entities
        : [{ entityID: args.entityID!, updates: args.updates! }];

      if (!updatesList[0]?.entityID || !updatesList[0]?.updates) {
        throw new Error("Either 'entityID' + 'updates' (single mode) or an 'entities' array (multi-entity mode) must be provided.");
      }

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          for (const item of updatesList) {
            const entity = t.entities.getEntity(item.entityID);
            if (!entity) {
              return { error: `Entity with ID ${item.entityID} not found` };
            }
            const entityFields = entity.fields as Record<string, any>;
            for (const [fieldName, value] of Object.entries(item.updates)) {
              const field = entityFields[fieldName];
              if (!field) {
                return { error: `Field '${fieldName}' not found on entity ${item.entityID}` };
              }
              t.update(field, value);
            }
          }
          return { ok: true };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      if (updatesList.length === 1) {
        const item = updatesList[0];
        return {
          content: [{
            type: "text",
            text: `Updated ${Object.keys(item.updates).length} fields on entity ${item.entityID}: ${JSON.stringify(item.updates)}`,
          }],
        };
      }

      const totalFields = updatesList.reduce((s, i) => s + Object.keys(i.updates).length, 0);
      return {
        content: [{
          type: "text",
          text: `Updated ${totalFields} fields across ${updatesList.length} entities.`,
        }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[update-entity-values] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to update entity values: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// update entity position tool (supports single or multi-entity via optional `updates` array)
srv.registerTool(
  "update-entity-position",
  {
    description: [
      "Update the position of one or more entities on the desktop.",
      "SINGLE MODE: provide entityID, x, y.",
      "MULTI-ENTITY MODE: provide an `updates` array to reposition multiple entities in one call (ideal for organizing layouts).",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().optional().describe("ID of the entity to move (single mode)"),
      x: z.number().optional().describe("New X position (single mode)"),
      y: z.number().optional().describe("New Y position (single mode)"),
      updates: z.array(z.object({
        entityID: z.string().describe("ID of the entity to move"),
        x: z.number().describe("New X position"),
        y: z.number().describe("New Y position"),
      })).optional().describe("Multi-entity mode: array of position updates. When provided, single-mode params are ignored."),
    }),
  },
  async (args: {
    entityID?: string;
    x?: number;
    y?: number;
    updates?: Array<{ entityID: string; x: number; y: number }>;
  }) => {
    try {
      const updatesList: Array<{ entityID: string; x: number; y: number }> = args.updates
        ? args.updates
        : [{ entityID: args.entityID!, x: args.x!, y: args.y! }];

      if (!updatesList[0]?.entityID) {
        throw new Error("Either 'entityID'+'x'+'y' (single mode) or an 'updates' array (multi-entity mode) must be provided.");
      }

      console.error(`[update-entity-position] Moving ${updatesList.length} entity(s)...`);
      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          for (const update of updatesList) {
            const entity = t.entities.getEntity(update.entityID);
            if (!entity) {
              return { error: `Entity with ID ${update.entityID} not found` };
            }
            const fields = entity.fields as any;
            if (!fields.positionX || !fields.positionY) {
              return { error: `Entity ${update.entityID} does not have positionX/positionY fields` };
            }
            t.update(fields.positionX, update.x);
            t.update(fields.positionY, update.y);
          }
          return { ok: true };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      if (updatesList.length === 1) {
        const u = updatesList[0];
        return {
          content: [{ type: "text", text: `Moved entity ${u.entityID} to position (${u.x}, ${u.y})` }],
        };
      }

      return {
        content: [{ type: "text", text: `Moved ${updatesList.length} entities successfully.` }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[update-entity-position] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to move entity: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// inspect entity tool (supports single or batch via optional `entityIDs` array)
srv.registerTool(
  "inspect-entity",
  {
    description: [
      "Inspect one or more entities to see available fields/parameters and their current values.",
      "SINGLE MODE: provide entityID.",
      "BATCH MODE: provide an `entityIDs` array to inspect multiple entities in one call.",
      "Crucial for discovering how to tweak entities and finding socket names for routing.",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().optional().describe("ID of the entity to inspect (single mode)"),
      entityIDs: z.array(z.string()).optional().describe("Batch mode: array of entity IDs to inspect in one call. When provided, single-mode entityID is ignored."),
    }),
  },
  async (args: { entityID?: string; entityIDs?: string[] }) => {
    try {
      const idsToInspect: string[] = args.entityIDs
        ? args.entityIDs
        : args.entityID ? [args.entityID] : [];

      if (idsToInspect.length === 0) {
        throw new Error("Either 'entityID' (single mode) or 'entityIDs' array (batch mode) must be provided.");
      }

      const doc = await getDocument();
      const allEntities = doc.queryEntities.get();

      const results: Array<{ id: string; type: string; fields: Record<string, any> }> = [];
      for (const entityID of idsToInspect) {
        const entity = allEntities.find((e) => e.id === entityID);
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

        results.push({ id: entityID, type: entity.entityType, fields: exportedFields });
      }

      if (results.length === 1) {
        const r = results[0];
        return {
          content: [{
            type: "text",
            text: `Entity ${r.id} (${r.type}) Fields:\n${JSON.stringify(r.fields, null, 2)}`,
          }],
        };
      }

      const output = results.map(r =>
        `Entity ${r.id} (${r.type}) Fields:\n${JSON.stringify(r.fields, null, 2)}`
      ).join("\n\n");

      return {
        content: [{ type: "text", text: output }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Failed to inspect entity: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// connect entities tool (supports single or batch via optional `connections` array)
srv.registerTool(
  "connect-entities",
  {
    description: [
      "Connect audio/note output(s) of entities to input(s) of others.",
      "SINGLE MODE: provide sourceEntityId, sourceField, targetEntityId, targetField, cableType.",
      "BATCH MODE: provide a `connections` array to wire multiple routes in one call (ideal for mastering chains or complex pipelines).",
      "Use inspect-entity to discover the correct socket field names (like 'audioOutput' and 'audioInput').",
    ].join("\n"),
    inputSchema: z.object({
      sourceEntityId: z.string().optional().describe("ID of the source entity (single mode)"),
      sourceField: z.string().optional().describe("Name of the source field (e.g. 'audioOutput' or 'mainOutput')"),
      targetEntityId: z.string().optional().describe("ID of the target entity (single mode)"),
      targetField: z.string().optional().describe("Name of the target field (e.g. 'audioInput' or 'audioInput1')"),
      cableType: z.string().optional().default("desktopAudioCable").describe("Type of cable to create. Default is 'desktopAudioCable'. For notes, use 'desktopNoteCable'."),
      connections: z.array(z.object({
        sourceEntityId: z.string().describe("ID of the source entity"),
        sourceField: z.string().describe("Name of the source field"),
        targetEntityId: z.string().describe("ID of the target entity"),
        targetField: z.string().describe("Name of the target field"),
        cableType: z.string().optional().default("desktopAudioCable").describe("Cable type"),
      })).optional().describe("Batch mode: array of connections to create in one call. When provided, single-mode params are ignored."),
    }),
  },
  async (args: {
    sourceEntityId?: string;
    sourceField?: string;
    targetEntityId?: string;
    targetField?: string;
    cableType?: string;
    connections?: Array<{
      sourceEntityId: string;
      sourceField: string;
      targetEntityId: string;
      targetField: string;
      cableType?: string;
    }>;
  }) => {
    try {
      const connectionsList: Array<{
        sourceEntityId: string;
        sourceField: string;
        targetEntityId: string;
        targetField: string;
        cableType: string;
      }> = args.connections
        ? args.connections.map(c => ({ ...c, cableType: c.cableType || "desktopAudioCable" }))
        : [{
            sourceEntityId: args.sourceEntityId!,
            sourceField: args.sourceField!,
            targetEntityId: args.targetEntityId!,
            targetField: args.targetField!,
            cableType: args.cableType || "desktopAudioCable",
          }];

      if (!connectionsList[0]?.sourceEntityId) {
        throw new Error("Either single-mode params (sourceEntityId, etc.) or a `connections` array must be provided.");
      }

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const createdCableIds: string[] = [];
          const socketsWiredInThisBatch = new Set<string>();

          for (const conn of connectionsList) {
            const { sourceEntityId, sourceField, targetEntityId, targetField, cableType } = conn;
            const sourceEntity = t.entities.getEntity(sourceEntityId);
            if (!sourceEntity) return { error: `Source entity ${sourceEntityId} not found` };

            const targetEntity = t.entities.getEntity(targetEntityId);
            if (!targetEntity) return { error: `Target entity ${targetEntityId} not found` };

            const sourceSocket = (sourceEntity.fields as any)[sourceField];
            if (!sourceSocket) {
              return { error: `Field '${sourceField}' does not exist on entity ${sourceEntityId}` };
            }
            if (!isLikelySocket(sourceSocket)) {
              const sourceType = (sourceEntity as any).type ?? "unknown";
              return {
                error:
                  `Field '${sourceField}' on entity ${sourceEntityId} (type: ${sourceType}) is not a valid audio/note socket. ` +
                  `Use inspect-entity to list the real socket names (e.g. a synth exposes 'audioOutput', a mixer channel exposes 'audioInput').`,
              };
            }

            const targetSocket = (targetEntity.fields as any)[targetField];
            if (!targetSocket) {
              return { error: `Field '${targetField}' does not exist on entity ${targetEntityId}` };
            }
            if (!isLikelySocket(targetSocket)) {
              const targetType = (targetEntity as any).type ?? "unknown";
              return {
                error:
                  `Field '${targetField}' on entity ${targetEntityId} (type: ${targetType}) is not a valid audio/note socket. ` +
                  `Use inspect-entity to list the real socket names (e.g. mixerChannel uses 'audioInput', mixerAux uses 'insertInput').`,
              };
            }

            // De-duplicate: if this audio/note input already has an incoming cable,
            // remove the old cable(s) before creating the new one. `toSocket` is a
            // PrimitiveField<NexusLocation> — `.location` points at the pointer field
            // itself, `.value` points at the socket the cable terminates at. We must
            // compare `.value` to `targetSocket.location`.
            const targetLocKey = String(targetSocket.location);
            if (!socketsWiredInThisBatch.has(targetLocKey)) {
              const existingCables = t.entities
                .ofTypes("desktopAudioCable" as any, "desktopNoteCable" as any)
                .get();
              for (const cable of existingCables) {
                const toSock = (cable.fields as any).toSocket;
                const pointed = toSock?.value as
                  | { equals?: (o: any) => boolean }
                  | undefined;
                if (pointed && targetSocket.location) {
                  if (
                    pointed.equals?.(targetSocket.location) ||
                    String(pointed) === targetLocKey
                  ) {
                    t.remove(cable.id);
                  }
                }
              }
              socketsWiredInThisBatch.add(targetLocKey);
            }

            const newCable = t.create(cableType as any, {
              fromSocket: sourceSocket.location,
              toSocket: targetSocket.location,
            });
            if (!newCable) return { error: `Failed to create cable for ${sourceEntityId} -> ${targetEntityId}` };

            createdCableIds.push((newCable as any).id);
          }
          return { ok: true, cableIds: createdCableIds };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      const cableIds = (modifyResult as any).cableIds as string[];
      if (cableIds.length === 1) {
        const conn = connectionsList[0];
        return {
          content: [{ type: "text", text: `Connected ${conn.sourceEntityId}.${conn.sourceField} to ${conn.targetEntityId}.${conn.targetField} using ${conn.cableType}. Cable ID: ${cableIds[0]}` }],
        };
      }

      return {
        content: [{ type: "text", text: `Successfully wired ${cableIds.length} connections. Cable IDs: ${cableIds.join(", ")}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to connect entities: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  },
);

// disconnect entities tool (supports single or batch via optional `cableIds` array)
srv.registerTool(
  "disconnect-entities",
  {
    description: [
      "Remove one or more cable connections by cable ID.",
      "SINGLE MODE: provide cableId.",
      "BATCH MODE: provide a `cableIds` array to remove multiple cables in one call.",
    ].join("\n"),
    inputSchema: z.object({
      cableId: z.string().optional().describe("ID of the cable to remove (single mode)"),
      cableIds: z.array(z.string()).optional().describe("Batch mode: array of cable IDs to remove in one call. When provided, single-mode cableId is ignored."),
    }),
  },
  async (args: { cableId?: string; cableIds?: string[] }) => {
    try {
      const idsToRemove: string[] = args.cableIds
        ? args.cableIds
        : args.cableId ? [args.cableId] : [];

      if (idsToRemove.length === 0) {
        throw new Error("Either 'cableId' (single mode) or 'cableIds' array (batch mode) must be provided.");
      }

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const removed: string[] = [];
          const missing: string[] = [];
          for (const id of idsToRemove) {
            const cable = t.entities.getEntity(id);
            if (!cable) {
              missing.push(id);
              continue;
            }
            t.remove(id);
            removed.push(id);
          }
          return { ok: true, removed, missing };
        } catch (innerError) {
          return { error: innerError instanceof Error ? innerError.message : String(innerError) };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      const removed = (modifyResult as any).removed as string[];
      const missing = (modifyResult as any).missing as string[];

      let text: string;
      if (removed.length === 1 && missing.length === 0) {
        text = `Successfully disconnected cable ${removed[0]}`;
      } else {
        text =
          `Disconnected ${removed.length} cable(s).` +
          (missing.length
            ? ` Skipped ${missing.length} already-removed id(s): ${missing.join(", ")}.`
            : "");
      }

      return { content: [{ type: "text", text }] };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Failed to disconnect cable: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// list entities tool
srv.registerTool(
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

// ─── update-project-config tool ─────────────────────────────────────────────
srv.registerTool(
  "update-project-config",
  {
    description: [
      "Update global project config values used by the timeline and transport.",
      "Supports tempo and time signature updates.",
      "Use this before generating or editing musical content that depends on BPM or meter.",
    ].join(" "),
    inputSchema: z.object({
      tempoBpm: z
        .number()
        .optional()
        .describe("Project tempo in BPM (must be > 0)."),
      timeSignatureNumerator: z
        .number()
        .int()
        .optional()
        .describe("Top number of time signature (e.g. 4 in 4/4)."),
      timeSignatureDenominator: z
        .number()
        .int()
        .optional()
        .describe("Bottom number of time signature (e.g. 4 in 4/4)."),
    }),
  },
  async (args: {
    tempoBpm?: number;
    timeSignatureNumerator?: number;
    timeSignatureDenominator?: number;
  }) => {
    try {
      const { tempoBpm, timeSignatureNumerator, timeSignatureDenominator } = args;
      const hasTempo = tempoBpm != null;
      const hasNumerator = timeSignatureNumerator != null;
      const hasDenominator = timeSignatureDenominator != null;

      if (!hasTempo && !hasNumerator && !hasDenominator) {
        throw new Error(
          "At least one config field must be provided (tempoBpm and/or timeSignatureNumerator+timeSignatureDenominator).",
        );
      }

      if (hasNumerator !== hasDenominator) {
        throw new Error(
          "Both timeSignatureNumerator and timeSignatureDenominator must be provided together.",
        );
      }

      if (hasTempo && tempoBpm! <= 0) {
        throw new Error("tempoBpm must be greater than 0.");
      }

      if (hasNumerator && timeSignatureNumerator! <= 0) {
        throw new Error("timeSignatureNumerator must be greater than 0.");
      }

      if (hasDenominator && timeSignatureDenominator! <= 0) {
        throw new Error("timeSignatureDenominator must be greater than 0.");
      }

      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const configEntity = t.entities.ofTypes("config" as any).get()[0];
          if (!configEntity) {
            return { error: "Config entity not found in project." };
          }

          const fields = configEntity.fields as any;
          const appliedUpdates: Record<string, number> = {};

          if (hasTempo) {
            if (!fields.tempoBpm) {
              return { error: "Config field 'tempoBpm' not found." };
            }
            t.update(fields.tempoBpm, tempoBpm);
            appliedUpdates.tempoBpm = tempoBpm!;
          }

          if (hasNumerator && hasDenominator) {
            if (!fields.signatureNumerator || !fields.signatureDenominator) {
              return {
                error:
                  "Config fields 'signatureNumerator' and/or 'signatureDenominator' not found.",
              };
            }
            t.update(fields.signatureNumerator, timeSignatureNumerator);
            t.update(fields.signatureDenominator, timeSignatureDenominator);
            appliedUpdates.timeSignatureNumerator = timeSignatureNumerator!;
            appliedUpdates.timeSignatureDenominator = timeSignatureDenominator!;
          }

          return { ok: true, appliedUpdates };
        } catch (innerError) {
          return {
            error:
              innerError instanceof Error
                ? innerError.message
                : String(innerError),
          };
        }
      });

      if ("error" in modifyResult) {
        throw new Error(modifyResult.error as string);
      }

      const appliedUpdates = (modifyResult as { ok: true; appliedUpdates: Record<string, number> }).appliedUpdates;
      return {
        content: [
          {
            type: "text",
            text: `Updated project config: ${JSON.stringify(appliedUpdates)}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      return {
        content: [
          {
            type: "text",
            text: `Failed to update project config: ${errorMsg}`,
          },
        ],
        isError: true,
      };
    }
  },
);

srv.registerTool(
  "get-project-summary",
  {
    description: [
      "Return a structured overview of the entire Audiotool project.",
      "Includes: config (tempo, time signature), all devices (instruments & effects),",
      "note tracks and audio tracks, cable connections (signal chain), and mixer layout.",
      "Call this to understand the current state of the project before making context-aware",
      "decisions such as generating complementary samples, mixing, or mastering.",
    ].join(" "),
    inputSchema: z.object({}),
  },
  async () => {
    try {
      const doc = await getDocument();
      const allEntities = doc.queryEntities.get();

      // Config
      const configEntity = allEntities.find((e) => e.entityType === "config");
      const configFields = configEntity?.fields as any;
      const config: Record<string, any> = {};
      if (configFields) {
        if (configFields.tempoBpm?.value != null) config.tempoBpm = configFields.tempoBpm.value;
        if (configFields.signatureNumerator?.value != null && configFields.signatureDenominator?.value != null) {
          config.timeSignature = `${configFields.signatureNumerator.value}/${configFields.signatureDenominator.value}`;
        }
      }

      // Devices (instruments & effects visible on the desktop)
      const validSet = new Set<string>(VALID_ENTITY_TYPES);
      const devices = allEntities
        .filter((e) => validSet.has(e.entityType))
        .map((e) => {
          const f = e.fields as any;
          return {
            id: e.id,
            type: e.entityType,
            displayName: f.displayName?.value ?? null,
            positionX: f.positionX?.value ?? null,
            positionY: f.positionY?.value ?? null,
          };
        });

      // Note tracks
      const noteTracks = allEntities
        .filter((e) => e.entityType === "noteTrack")
        .map((e) => {
          const f = e.fields as any;
          return {
            id: e.id,
            displayName: f.displayName?.value ?? null,
            orderAmongTracks: f.orderAmongTracks?.value ?? null,
            playerEntityId: refId(f.player),
          };
        });

      // Audio tracks
      const audioTracks = allEntities
        .filter((e) => e.entityType === "audioTrack")
        .map((e) => {
          const f = e.fields as any;
          return {
            id: e.id,
            displayName: f.displayName?.value ?? null,
            orderAmongTracks: f.orderAmongTracks?.value ?? null,
            playerEntityId: refId(f.player),
          };
        });

      // Cable connections (signal chain)
      const cables = allEntities
        .filter((e) => e.entityType === "desktopAudioCable" || e.entityType === "desktopNoteCable")
        .map((e) => {
          const f = e.fields as any;
          return {
            id: e.id,
            type: e.entityType,
            from: refId(f.fromSocket),
            to: refId(f.toSocket),
          };
        });

      // Mixer strips
      const mixerTypes = ["mixerChannel", "mixerMaster", "mixerGroup", "mixerAux", "mixerReverbAux", "mixerDelayAux"];
      const mixer = allEntities
        .filter((e) => mixerTypes.includes(e.entityType))
        .map((e) => {
          const f = e.fields as any;
          const dp = f.displayParameters?.fields;
          return {
            id: e.id,
            type: e.entityType,
            displayName: dp?.displayName?.value ?? null,
            orderAmongStrips: dp?.orderAmongStrips?.value ?? null,
          };
        });

      const summary = { config, devices, noteTracks, audioTracks, cables, mixer };
      console.error(`[get-project-summary] devices=${devices.length} noteTracks=${noteTracks.length} audioTracks=${audioTracks.length} cables=${cables.length}`);

      return {
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[get-project-summary] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to get project summary: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// ─── export-tracks-abc tool ───────────────────────────────────────────────
srv.registerTool(
  "export-tracks-abc",
  {
    description: [
      "Read existing note tracks from the project and export their note content as ABC notation.",
      "This lets you see what melodies, chords, and rhythms already exist in the project.",
      "Use this to analyze musical content before generating complementary parts,",
      "or to understand the key, scale, and chord progression of existing music.",
      "Returns one ABC block per note track, including the instrument type.",
    ].join(" "),
    inputSchema: z.object({
      noteTrackId: z
        .string()
        .optional()
        .describe("ID of a specific note track to export. If omitted, all note tracks are exported."),
    }),
  },
  async (args: { noteTrackId?: string }) => {
    try {
      const doc = await getDocument();
      const allEntities = doc.queryEntities.get();

      // Read config for tempo / time signature
      const configEntity = allEntities.find((e) => e.entityType === "config");
      const cf = configEntity?.fields as any;
      const abcConfig = {
        tempoBpm: cf?.tempoBpm?.value as number | undefined,
        timeSignatureNum: cf?.signatureNumerator?.value as number | undefined,
        timeSignatureDen: cf?.signatureDenominator?.value as number | undefined,
      };

      // Find target note tracks
      const allNoteTracks = allEntities.filter((e) => e.entityType === "noteTrack");
      const targetTracks = args.noteTrackId
        ? allNoteTracks.filter((e) => e.id === args.noteTrackId)
        : allNoteTracks;

      if (targetTracks.length === 0) {
        return {
          content: [{ type: "text", text: args.noteTrackId
            ? `Note track ${args.noteTrackId} not found.`
            : "No note tracks found in the project." }],
        };
      }

      // Index note regions, collections, and notes
      const noteRegions = allEntities.filter((e) => e.entityType === "noteRegion");
      const noteCollections = allEntities.filter((e) => e.entityType === "noteCollection");
      const noteEntities = allEntities.filter((e) => e.entityType === "note");
      const notesByCollectionRef = new Map<string, typeof allEntities>();
      const notesByRegionRef = new Map<string, typeof allEntities>();
      for (const noteEntity of noteEntities) {
        const nf = noteEntity.fields as any;
        const collectionRef = refId(nf.collection) ?? refId(nf.noteCollection);
        const regionRef = refId(nf.region) ?? refId(nf.noteRegion);
        if (collectionRef) {
          const existing = notesByCollectionRef.get(collectionRef);
          if (existing) {
            existing.push(noteEntity);
          } else {
            notesByCollectionRef.set(collectionRef, [noteEntity]);
          }
        }
        if (regionRef) {
          const existing = notesByRegionRef.get(regionRef);
          if (existing) {
            existing.push(noteEntity);
          } else {
            notesByRegionRef.set(regionRef, [noteEntity]);
          }
        }
      }
      console.error(
        `[export-tracks-abc] Entity counts: noteRegions=${noteRegions.length} noteCollections=${noteCollections.length} notes=${noteEntities.length}`,
      );

      const results: Array<{ trackId: string; instrument: string | null; abc: string; noteCount: number }> = [];

      for (const track of targetTracks) {
        const tf = track.fields as any;
        const playerRef = refId(tf.player);

        let instrumentType: string | null = null;
        if (playerRef) {
          const playerEntity = allEntities.find((e) => e.id === playerRef);
          instrumentType = playerEntity?.entityType ?? null;
        }
        console.error(
          `[export-tracks-abc] Track ${track.id}: player=${playerRef} instrument=${instrumentType}`,
        );

        // Find note regions belonging to this track
        const trackRegions = noteRegions.filter((r) => {
          const rf = r.fields as any;
          const trackRef = refId(rf.track);
          return trackRef === track.id;
        });
        console.error(
          `[export-tracks-abc]   regions found: ${trackRegions.length}`,
        );

        const noteEvents: Array<{ pitch: number; positionTicks: number; durationTicks: number; velocity: number }> = [];

        for (const region of trackRegions) {
          const rf = region.fields as any;
          const regionOffset = rf.region?.fields?.positionTicks?.value ?? rf.positionTicks?.value ?? 0;

          // Primary field name is "collection" (matches add-abc-track creation).
          // Fall back to "noteCollection" in case a different Audiotool version uses that name.
          const collectionRef = refId(rf.collection) ?? refId(rf.noteCollection);

          console.error(
            `[export-tracks-abc]   region ${region.id}: offset=${regionOffset} collectionRef=${collectionRef}`,
          );

          let regionNotes: typeof allEntities = [];
          if (collectionRef) {
            const collection = noteCollections.find((c) => c.id === collectionRef);
            if (collection) {
              regionNotes = notesByCollectionRef.get(collection.id) ?? [];
            }
            console.error(
              `[export-tracks-abc]     via collection: found ${regionNotes.length} notes`,
            );
          }
          // Fallback: notes referencing this region directly
          if (regionNotes.length === 0) {
            regionNotes = notesByRegionRef.get(region.id) ?? [];
            if (regionNotes.length > 0) {
              console.error(
                `[export-tracks-abc]     via region fallback: found ${regionNotes.length} notes`,
              );
            }
          }

          for (const noteEntity of regionNotes) {
            const nf = noteEntity.fields as any;
            const pitch = nf.pitch?.value ?? 60;
            const posTicks = (nf.positionTicks?.value ?? 0) + regionOffset;
            const durTicks = nf.durationTicks?.value ?? TICKS_QUARTER;
            const velocity = nf.velocity?.value ?? 0.7;
            noteEvents.push({ pitch, positionTicks: posTicks, durationTicks: durTicks, velocity });
          }
        }

        const abc = notesToAbc(noteEvents, abcConfig);
        results.push({ trackId: track.id, instrument: instrumentType, abc, noteCount: noteEvents.length });
      }

      const output = results.map((r) => {
        const label = r.instrument ? `Track ${r.trackId} (${r.instrument})` : `Track ${r.trackId}`;
        return `--- ${label} [${r.noteCount} notes] ---\n${r.abc}`;
      }).join("\n\n");

      console.error(`[export-tracks-abc] Exported ${results.length} track(s), total ${results.reduce((s, r) => s + r.noteCount, 0)} notes`);
      return {
        content: [{ type: "text", text: output }],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[export-tracks-abc] ERROR:`, errorMsg);
      return {
        content: [{ type: "text", text: `Failed to export tracks: ${errorMsg}` }],
        isError: true,
      };
    }
  },
);

// Device types that support presets (keys of PRESET_TARGET_RELATIVE_TYPES
// whose value is not `undefined`).  Kept as a literal tuple so the Zod enum
// types line up with the SDK's DevicePresetEntityType at compile time.
const PRESET_SUPPORTED_DEVICE_TYPES = [
  "heisenberg",
  "bassline",
  "pulverisateur",
  "space",
  "tonematrix",
  "machiniste",
  "beatbox8",
  "beatbox9",
  "quasar",
  "rasselbock",
  "pulsar",
  "quantum",
  "matrixArpeggiator",
  "noteSplitter",
  "gakki",
  "curve",
  "graphicalEQ",
  "gravity",
  "autoFilter",
  "waveshaper",
  "helmholtz",
  "stereoEnhancer",
  "exciter",
  "panorama",
  "crossfader",
  "bandSplitter",
  "stompboxChorus",
  "stompboxCompressor",
  "stompboxCrusher",
  "stompboxDelay",
  "stompboxFlanger",
  "stompboxGate",
  "stompboxParametricEqualizer",
  "stompboxPhaser",
  "stompboxPitchDelay",
  "stompboxReverb",
  "stompboxSlope",
  "stompboxStereoDetune",
  "stompboxTube",
] as const;

// list-presets tool
srv.registerTool(
  "list-presets",
  {
    description: [
      "List available factory/user presets for a given device type.",
      "Use this before apply-preset to find a preset id matching the user's mood",
      "(e.g. 'wide lead', 'fat bass', 'dark pad'). Returns at most 20 results.",
    ].join("\n"),
    inputSchema: z.object({
      deviceType: z
        .enum(PRESET_SUPPORTED_DEVICE_TYPES)
        .describe(
          "Entity type that supports presets (heisenberg, bassline, stompboxReverb, ...).",
        ),
      textSearch: z
        .string()
        .optional()
        .describe(
          "Optional text filter, matched against preset name/description (e.g. 'lead', 'wide', 'bass').",
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe("Max results (default 20)."),
    }),
  },
  async (args: {
    deviceType: (typeof PRESET_SUPPORTED_DEVICE_TYPES)[number];
    textSearch?: string;
    limit?: number;
  }) => {
    try {
      const client = await getClient();
      const raw = await client.presets.list(
        args.deviceType as any,
        args.textSearch,
      );
      const capped = raw.slice(0, args.limit ?? 20);
      const trimmed = capped.map((p: any) => ({
        id: p?.meta?.id ?? p?.meta?.name ?? "",
        name: p?.meta?.name ?? "",
        description: p?.meta?.description ?? "",
      }));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                deviceType: args.deviceType,
                count: trimmed.length,
                presets: trimmed,
              },
              null,
              2,
            ),
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Failed to list presets: ${msg}` }],
        isError: true,
      };
    }
  },
);

// apply-preset tool
srv.registerTool(
  "apply-preset",
  {
    description: [
      "Apply a preset (by id) to an existing entity. The entity type must match the preset's device type.",
      "Use after list-presets to pick a preset id. Supports uuid or 'presets/{uuid}' form.",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().describe("ID of the target device entity."),
      presetID: z
        .string()
        .describe("Preset id - either a uuid or 'presets/{uuid}'."),
    }),
  },
  async (args: { entityID: string; presetID: string }) => {
    try {
      const client = await getClient();
      const doc = await getDocument();
      const preset = await client.presets.get(args.presetID);
      const result = await doc.modify((t) => {
        const entity = t.entities.getEntity(args.entityID);
        if (!entity)
          return { error: `Entity with ID ${args.entityID} not found` };
        try {
          (t as any).applyPresetTo(entity, preset);
        } catch (innerError) {
          return {
            error:
              innerError instanceof Error
                ? innerError.message
                : String(innerError),
          };
        }
        return { ok: true };
      });
      if ("error" in result) throw new Error(result.error as string);
      return {
        content: [
          {
            type: "text",
            text: `Applied preset ${args.presetID} to entity ${args.entityID}.`,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: "text", text: `Failed to apply preset: ${msg}` }],
        isError: true,
      };
    }
  },
);

// recommend-entity-for-style tool
srv.registerTool(
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

} // end registerTools

// Register tools on the default server instance (used by stdio mode).
registerTools(server);

// ---------------------------------------------------------------------------
// Global error handlers — prevent silent crashes from the nexus SDK or
// unhandled promise rejections.
// ---------------------------------------------------------------------------
process.on("uncaughtException", (err) => {
  console.error("[FATAL] Uncaught exception:", err);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] Unhandled rejection:", reason);
  process.exit(1);
});

process.on("warning", (warning) => {
  console.error("[WARN] Process warning:", warning);
});

process.on("beforeExit", (code) => {
  console.error(`[shutdown] beforeExit with code=${code}`);
});

process.on("exit", (code) => {
  console.error(`[shutdown] exit with code=${code}`);
});

// ---------------------------------------------------------------------------
// Graceful shutdown — single handler for all termination signals with a hard
// timeout so the process always exits even if cleanup hangs.
// ---------------------------------------------------------------------------

let _httpServer: ReturnType<typeof createServer> | null = null;
let _isShuttingDown = false;

async function gracefulShutdown(signal: string): Promise<void> {
  if (_isShuttingDown) return;
  _isShuttingDown = true;
  console.error(`[shutdown] ${signal} received, cleaning up...`);

  const SHUTDOWN_TIMEOUT_MS = 5000;

  const cleanup = async () => {
    stopMemoryHeartbeat();
    clearSessionIdleTimer();
    try {
      await cleanupCurrentSession();
    } catch (e) {
      console.error("[shutdown] cleanupCurrentSession error:", e);
    }
    if (activeSession) {
      try {
        await activeSession.transport.close();
      } catch (e) {
        console.error("[shutdown] transport.close() error:", e);
      }
      activeSession = null;
    }
    if (_httpServer) {
      _httpServer.close();
    }
  };

  const timeout = new Promise<void>((resolve) => {
    setTimeout(() => {
      console.error("[shutdown] Cleanup timed out, forcing exit");
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });

  await Promise.race([cleanup(), timeout]);
  process.exit(0);
}

for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
  process.on(sig, () => {
    gracefulShutdown(sig);
  });
}

// Start the server
const useHttpTransport = (process.env.MCP_TRANSPORT || "").toLowerCase() === "http";
ensureMemoryHeartbeat();

if (useHttpTransport) {
  // -----------------------------------------------------------------------
  // Stateful HTTP mode — one McpServer + transport per session.
  //
  // The SDK enforces one transport per McpServer.  To support client
  // reconnects we create a fresh McpServer + transport whenever a POST
  // arrives without a session ID (= new client initialising).  Subsequent
  // requests carrying the mcp-session-id header are routed to the existing
  // transport.  Since only one Python backend connects at a time, we keep
  // at most one active session and tear down the old one on reconnect.
  // -----------------------------------------------------------------------

  const sessionIdleTimeoutMsRaw = Number(
    process.env.MCP_SESSION_IDLE_TIMEOUT_MS || 15 * 60 * 1000,
  );
  const sessionIdleTimeoutMs = Number.isFinite(sessionIdleTimeoutMsRaw)
    ? Math.max(0, sessionIdleTimeoutMsRaw)
    : 15 * 60 * 1000;

  function markActiveSessionActivity(reason: string): void {
    if (!activeSession || sessionIdleTimeoutMs <= 0) return;

    activeSession.lastActivityAtMs = Date.now();
    clearSessionIdleTimer();

    const sessionId = activeSession.id;
    sessionIdleTimer = setTimeout(() => {
      void (async () => {
        if (!activeSession || activeSession.id !== sessionId) return;
        const idleMs = Date.now() - activeSession.lastActivityAtMs;
        if (idleMs < sessionIdleTimeoutMs) {
          markActiveSessionActivity("idle-timeout-reschedule");
          return;
        }
        console.error(
          `[session] Idle timeout reached for ${sessionId} after ${idleMs}ms (threshold ${sessionIdleTimeoutMs}ms)`,
        );
        logMemoryDiag("session-idle-timeout", {
          session: sessionId,
          idleMs,
          timeoutMs: sessionIdleTimeoutMs,
        });
        await teardownActiveSession("idle-timeout");
      })().catch((e) => {
        console.error("[session] Idle-timeout teardown failed:", e);
      });
    }, sessionIdleTimeoutMs);
    sessionIdleTimer.unref?.();

    const verboseIdleLogs =
      (process.env.MCP_SESSION_IDLE_VERBOSE || "0").trim().toLowerCase() === "1";
    if (verboseIdleLogs && reason) {
      console.error(`[session] Activity heartbeat (${reason}) for ${sessionId}`);
    }
  }

  if (sessionIdleTimeoutMs > 0) {
    console.error(
      `[session] Idle timeout enabled: ${sessionIdleTimeoutMs}ms (set MCP_SESSION_IDLE_TIMEOUT_MS=0 to disable)`,
    );
  } else {
    console.error("[session] Idle timeout disabled");
  }

  async function teardownActiveSession(reason = "unspecified"): Promise<void> {
    if (!activeSession) return;
    const closingSession = activeSession;
    activeSession = null;
    clearSessionIdleTimer();
    console.error(
      `[session] Tearing down session ${closingSession.id} reason=${reason}`,
    );
    logMemoryDiag("teardown-start", { session: closingSession.id, reason });
    try {
      await cleanupCurrentSession();
      await closingSession.transport.close();
    } catch (e) {
      console.error("[session] Error during teardown:", e);
    }
    logMemoryDiag("teardown-complete");
    if (process.env.MCP_GC_AFTER_TEARDOWN === "1" && typeof global.gc === "function") {
      global.gc();
      logMemoryDiag("teardown-post-gc");
    }
  }

  async function createNewSession(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): Promise<void> {
    // Tear down any prior session first.
    await teardownActiveSession("new-session");

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
    });

    const perRequestServer = createMcpServer();
    registerTools(perRequestServer);

    transport.onclose = () => {
      console.error("[session] Transport closed");
      logMemoryDiag("transport-closed");
      if (activeSession?.transport !== transport) return;
      activeSession = null;
      clearSessionIdleTimer();
      void cleanupCurrentSession().catch((e) => {
        console.error("[session] cleanup on close error:", e);
      });
    };

    const disposeTransport = async (reason: string) => {
      try {
        await transport.close();
      } catch (e) {
        console.error(`[session] transport.close() after ${reason}:`, e);
      }
    };

    try {
      await perRequestServer.connect(transport);
    } catch (err) {
      console.error("[mcp-http] Failed to connect transport:", err);
      await disposeTransport("connect-failed");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Failed to initialize session" }));
      }
      return;
    }

    // The transport assigns the session ID during the initialize handshake.
    // We grab it after handleRequest completes.  However, the SDK exposes
    // `sessionId` on the transport only after the initialize response is
    // sent, so we also listen for the response to extract it.
    try {
      await transport.handleRequest(req, res);
    } catch (err) {
      console.error("[mcp-http] MCP handleRequest failed:", err);
      await disposeTransport("handleRequest-failed");
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Failed to handle MCP request" }));
      }
      return;
    }

    // After the initialize handshake the transport has a sessionId.
    const sid = (transport as unknown as { sessionId?: string }).sessionId;
    if (sid) {
      activeSession = {
        id: sid,
        server: perRequestServer,
        transport,
        lastActivityAtMs: Date.now(),
      };
      console.error(`[session] New session created: ${sid}`);
      markActiveSessionActivity("session-created");
    } else {
      // Without a session id we cannot route further requests here; leaving
      // the transport open leaks an McpServer + handlers on every reconnect.
      console.error(
        "[session] No session ID after handshake — closing transport to avoid leaking memory",
      );
      await disposeTransport("no-session-id");
    }
  }

  const port = Number(process.env.PORT || 3001);
  _httpServer = createServer(async (req, res) => {
    try {
      const method = req.method || "GET";
      const requestUrl = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
      const pathname = requestUrl.pathname;
      const startedAt = Date.now();
      const requestId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;

      if (method === "GET" && pathname === "/health") {
        res.statusCode = 200;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ status: "ok" }));
        return;
      }

      if (pathname !== "/mcp") {
        res.statusCode = 404;
        res.end("Not found");
        return;
      }

      if (method !== "GET" && method !== "POST" && method !== "DELETE") {
        res.statusCode = 405;
        res.end("Method not allowed");
        return;
      }

      // Request-level diagnostics.
      let responseFinished = false;
      const sessionHeader = String(req.headers["mcp-session-id"] || "");
      const requestHeaderId = String(req.headers["x-request-id"] || "");
      const lastEventId = String(req.headers["last-event-id"] || "");
      const userAgent = String(req.headers["user-agent"] || "");
      res.on("finish", () => {
        responseFinished = true;
        const durationMs = Date.now() - startedAt;
        console.error(
          "[mcp-http] request-complete",
          JSON.stringify({
            requestId,
            method,
            path: pathname,
            statusCode: res.statusCode,
            durationMs,
            sessionHeader: sessionHeader || null,
            requestHeaderId: requestHeaderId || null,
            lastEventId: lastEventId || null,
            userAgent: userAgent || null,
          }),
        );
      });
      req.on("aborted", () => {
        const durationMs = Date.now() - startedAt;
        console.error(
          "[mcp-http] request-aborted",
          JSON.stringify({
            requestId,
            method,
            path: pathname,
            durationMs,
            sessionHeader: sessionHeader || null,
            requestHeaderId: requestHeaderId || null,
            lastEventId: lastEventId || null,
            userAgent: userAgent || null,
          }),
        );
      });
      res.on("close", () => {
        if (responseFinished) return;
        const durationMs = Date.now() - startedAt;
        console.error(
          "[mcp-http] response-closed-before-finish",
          JSON.stringify({
            requestId,
            method,
            path: pathname,
            statusCode: res.statusCode,
            durationMs,
            sessionHeader: sessionHeader || null,
            requestHeaderId: requestHeaderId || null,
            lastEventId: lastEventId || null,
            userAgent: userAgent || null,
          }),
        );
      });

      // Diagnostic: log memory breakdown on every MCP request.
      logMemoryDiag(`${method} ${pathname}`, {
        session: sessionHeader || "none",
        requestId,
      });

      // ---- Session routing ----

      if (method === "POST" && !sessionHeader) {
        // No session ID → new client initialising.
        await createNewSession(req, res);
        return;
      }

      if (method === "DELETE" && sessionHeader && activeSession && sessionHeader === activeSession.id) {
        // Client explicitly closing the session.
        markActiveSessionActivity("client-delete");
        try {
          await activeSession.transport.handleRequest(req, res);
        } finally {
          await teardownActiveSession("client-delete");
        }
        return;
      }

      if (sessionHeader && activeSession && sessionHeader === activeSession.id) {
        // Known session → route to its transport.
        markActiveSessionActivity("request-start");
        try {
          await activeSession.transport.handleRequest(req, res);
        } finally {
          markActiveSessionActivity("request-complete");
        }
        return;
      }

      // Unknown or stale session ID → 404 per MCP spec.
      // The Python client should discard the session and reinitialize.
      console.error(`[session] Unknown session ID: ${sessionHeader} (active: ${activeSession?.id ?? "none"})`);
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Session not found. Please reinitialize." },
          id: null,
        }),
      );
    } catch (err) {
      console.error("[mcp-http] Request error:", err instanceof Error ? err.stack : err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  _httpServer.on("error", (err) => {
    console.error("[mcp-http] Server error:", err);
    process.exit(1);
  });

  _httpServer.listen(port, () => {
    console.error(`[mcp-http] Listening on port ${port} at /mcp`);
  });
} else {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
