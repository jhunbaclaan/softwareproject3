// required imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getLoginStatus,
  createAudiotoolClient,
  SyncedDocument,
} from "@audiotool/nexus";
import { TokenManager } from "./token-manager.js";

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
  "heisenberg",
  "bassline",
  "machiniste",
  "tonematrix",
  "stompboxDelay",
] as const;

const ENTITY_TYPE_ALIASES: Record<string, string> = {
  machinedrum: "machiniste",
  "drum machine": "machiniste",
  drummachine: "machiniste",
};

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
      console.error("[initialize-session] ERROR:", error);
      throw error;
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
      "Entity types and their musical roles:",
      "  - 'heisenberg': polyphonic synth — pads, keys, chords, leads, atmospheric textures",
      "  - 'bassline': monophonic bass synth — bass lines, acid sounds, sub-bass",
      "  - 'machiniste': drum machine — beats, percussion, rhythmic patterns (also accepts 'machinedrum')",
      "  - 'tonematrix': step sequencer — melodic loops, arpeggios, generative patterns",
      "  - 'stompboxDelay': delay effect — echo, reverb-like delay, spatial effects",
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
    }),
  },
  async (args: {
    entityType: string;
    properties?: Record<string, any>;
    x?: number;
    y?: number;
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
          };

          const newEntity = t.create(resolvedType as any, entityProperties);

          if (!newEntity) {
            return {
              error: `Failed to create entity: t.create returned undefined`,
            };
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
