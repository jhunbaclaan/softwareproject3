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
  connectDeviceToStagebox,
  setHeisenbergOperatorAGain,
  recommendEntityForStyle,
} from "./server-utils.js";

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

      const exportedFields: Record<string, any> = {};
      if (entity && entity.fields) {
        const fields = entity.fields as Record<string, any>;
        for (const [key, field] of Object.entries(fields)) {
          if (field && typeof field === 'object' && 'value' in field) {
            exportedFields[key] = field.value;
          } else if (field && typeof field === 'object' && 'location' in field) {
            exportedFields[key] = `[Socket/Port: ${field.location}]`;
          }
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Added ${resolvedType} at position (${posX}, ${posY}). Entity ID: ${entity?.id}\nAvailable Fields & Ports:\n${JSON.stringify(exportedFields, null, 2)}`,
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

// batch-add-entities tool
server.registerTool(
  "batch-add-entities",
  {
    description: "Add multiple entities to the Audiotool project at once to save time.",
    inputSchema: z.object({
      entities: z.array(z.object({
        entityType: z.string().describe("Type of entity to add"),
        properties: z.record(z.string(), z.any()).optional().describe("Properties"),
        x: z.number().optional().describe("X position (optional)"),
        y: z.number().optional().describe("Y position (optional)"),
        autoConnectToMixer: z.boolean().optional().default(true).describe("Whether to automatically connect to mixer")
      })).describe("Array of entities to create")
    })
  },
  async (args: {
    entities: Array<{
      entityType: string;
      properties?: Record<string, any>;
      x?: number;
      y?: number;
      autoConnectToMixer?: boolean;
    }>
  }) => {
    try {
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

          for (const ent of args.entities) {
            const { properties } = ent;
            const resolvedType = resolveEntityType(ent.entityType);
            if (!resolvedType) return { error: `Unknown entity type: '${ent.entityType}'` };
            
            const posX = ent.x ?? autoLayoutOffset * 120;
            const posY = ent.y ?? 0;
            autoLayoutOffset++;
            
            const entityProperties = {
              ...(properties || {}),
              positionX: posX,
              positionY: posY,
              gain: 0.5,
              displayName: (properties?.displayName as string) ?? `${resolvedType} ${autoLayoutOffset}`,
            };
            
            const newEntity = t.create(resolvedType as any, entityProperties);
            if (!newEntity) return { error: `Failed to create entity: t.create returned undefined` };
            
            if (ent.autoConnectToMixer !== false) {
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
      let finalString = "Successfully added entities:\n";
      for (const res of entities) {
        finalString += `- ${res.type} at (${res.posX}, ${res.posY}). Entity ID: ${res.id}\n  Available Fields & Ports: ${JSON.stringify(res.fields)}\n`;
      }
      return { content: [{ type: "text", text: finalString }] };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[batch-add-entities] ERROR:`, errorMsg);
      return { content: [{ type: "text", text: `Failed to add entities: ${errorMsg}` }], isError: true };
    }
  }
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
      autoConnectToMixer: z
        .boolean()
        .optional()
        .default(true)
        .describe(
          "Whether to automatically connect this instrument's output to a new mixer channel. Set to false if you plan to manually route it through a mastering chain."
        ),
    }),
  },
  async (args: {
    abcNotation: string;
    instrument?: string;
    orchestralVoice?: string;
    playerEntityId?: string;
    x?: number;
    y?: number;
    autoConnectToMixer?: boolean;
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
          let resolvedPlayerEntityId: string;
          if (args.playerEntityId) {
            const playerEntity = t.entities.getEntity(args.playerEntityId);
            if (!playerEntity) {
              return { error: `Player entity ${args.playerEntityId} not found` };
            }
            playerLocation = playerEntity as any;
            resolvedPlayerEntityId = args.playerEntityId;
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
            if (args.autoConnectToMixer !== false) {
              connectDeviceToStagebox(t, player, instrumentType);
            }
            if (instrumentType === "heisenberg") {
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
            playerEntityId: resolvedPlayerEntityId,
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

      const { noteTrackId, noteCount, playerEntityId } = result as {
        noteTrackId: string;
        noteCount: number;
        playerEntityId: string;
      };
      console.error(
        `[add-abc-track] Added track with ${noteCount} notes, track ID: ${noteTrackId}, player ID: ${playerEntityId}`,
      );

      return {
        content: [
          {
            type: "text",
            text: `Added ABC track with ${noteCount} notes. NoteTrack ID: ${noteTrackId}. Player Entity ID: ${playerEntityId}`,
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
// update entity values (batch) tool
server.registerTool(
  "update-entity-values",
  {
    description: [
      "Update multiple parameters/fields on an entity at once. Use ONLY valid field names for the entity type:",
      "  heisenberg: gain [0-1], glideMs [0-5000], tuneSemitones [-12,12], playModeIndex [1-3], unisonoCount [1-4], unisonoDetuneSemitones [0-1], unisonoStereoSpreadFactor [-1,1], velocityFactor [0-1], operatorDetuneModeIndex [1-2], isActive (bool)",
      "  bassline: cutoffFrequencyHz [220-12000], filterDecay [0-1], filterEnvelopeModulationDepth [0-1], filterResonance [0-1], accent [0-1], gain [0-1], tuneSemitones [-12,12], waveformIndex [1-2], patternIndex [0-27], isActive (bool)",
      "  machiniste: globalModulationDepth [-1,1], mainOutputGain [0-1], patternIndex [0-31], isActive (bool)",
      "  tonematrix: patternIndex [0-7], isActive (bool)",
      "  stompboxDelay: feedbackFactor [0-1], mix [0-1], stepCount [1-7], stepLengthIndex [1-3], isActive (bool)",
      "For other entities, use the 'inspect-entity' tool (or check the output of add-entity) to discover the exact names of available fields and their types.",
    ].join("\n"),
    inputSchema: z.object({
      entityID: z.string().describe("ID of the entity to update"),
      updates: z.record(z.string(), z.union([z.number(), z.boolean()])).describe("Map of field names to new values. e.g. {'gain': 0.5, 'mix': 0.8, 'isActive': false}"),
    }),
  },
  async (args: {
    entityID: string;
    updates: Record<string, number | boolean>;
  }) => {
    try {
      const { entityID, updates } = args;
      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          const entity = t.entities.getEntity(entityID);
          if (!entity) {
            return { error: `Entity with ID ${entityID} not found` };
          }

          const entityFields = entity.fields as Record<string, any>;
          for (const [fieldName, value] of Object.entries(updates)) {
            const field = entityFields[fieldName];
            if (!field) {
              return {
                error: `Field '${fieldName}' not found on entity ${entityID}`,
              };
            }
            t.update(field, value);
          }
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
            text: `Updated ${Object.keys(updates).length} fields on entity ${entityID} to new values: ${JSON.stringify(updates)}`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[update-entity-values] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to update entity values: ${errorMsg}`,
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

// update entity positions (batch) tool
server.registerTool(
  "update-entity-positions",
  {
    description: "Update the position of multiple entities on the desktop at once. Use this to organize layouts efficiently.",
    inputSchema: z.object({
      updates: z.array(z.object({
        entityID: z.string().describe("ID of the entity to move"),
        x: z.number().describe("New X position"),
        y: z.number().describe("New Y position"),
      })).describe("List of position updates"),
    }),
  },
  async (args: { updates: Array<{ entityID: string; x: number; y: number }> }) => {
    try {
      const { updates } = args;
      console.error(`[update-entity-positions] Moving ${updates.length} entities...`);
      const doc = await getDocument();

      const modifyResult = await doc.modify((t) => {
        try {
          for (const update of updates) {
            const entity = t.entities.getEntity(update.entityID);
            if (!entity) {
              return { error: `Entity with ID ${update.entityID} not found` };
            }

            const fields = entity.fields as any;
            if (!fields.positionX || !fields.positionY) {
              return {
                error: `Entity ${update.entityID} does not have positionX/positionY fields`,
              };
            }

            t.update(fields.positionX, update.x);
            t.update(fields.positionY, update.y);
          }
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

      console.error(`[update-entity-positions] Successfully moved ${updates.length} entities`);
      return {
        content: [
          {
            type: "text",
            text: `Moved ${updates.length} entities successfully.`,
          },
        ],
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[update-entity-positions] ERROR:`, errorMsg);
      return {
        content: [
          {
            type: "text",
            text: `Failed to move entities: ${errorMsg}`,
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
          
          // Auto-disconnect existing cables targeting this input socket to prevent multiple-pointer validation errors
          const existingCables = t.entities.ofTypes("desktopAudioCable" as any, "desktopNoteCable" as any).get();
          for (const cable of existingCables) {
            const toSock = (cable.fields as any).toSocket;
            if (toSock && toSock.location && targetSocket.location) {
              if (toSock.location.id === targetSocket.location.id || toSock.location === targetSocket.location) {
                t.remove(cable.id);
              }
            }
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

// batch connect entities tool
server.registerTool(
  "batch-connect-entities",
  {
    description: "Connect multiple entity audio/note ports in a single batch operation. Extremely useful for wiring up mastering chains or complex synth pipelines quickly.",
    inputSchema: z.object({
      connections: z.array(z.object({
        sourceEntityId: z.string().describe("ID of the source entity (e.g. the synthesizer or effect outputting signal)"),
        sourceField: z.string().describe("Name of the source field (e.g. 'audioOutput' or 'mainOutput')"),
        targetEntityId: z.string().describe("ID of the target entity (e.g. an effect or mixerChannel receiving signal)"),
        targetField: z.string().describe("Name of the target field (e.g. 'audioInput' or 'audioInput1')"),
        cableType: z.string().optional().default("desktopAudioCable").describe("Type of cable to create. Default is 'desktopAudioCable'. For notes, use 'desktopNoteCable'."),
      })).describe("Array of connections to create"),
    }),
  },
  async (args) => {
    try {
      const { connections } = args;
      const doc = await getDocument();
      
      const modifyResult = await doc.modify((t) => {
        try {
          const createdCableIds: string[] = [];
          const socketsWiredInThisBatch = new Set<string>();
          for (const conn of connections) {
            const { sourceEntityId, sourceField, targetEntityId, targetField, cableType } = conn;
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
            
            // Auto-disconnect existing cables targeting this input socket, BUT ONLY if we haven't wired to it in this batch.
            if (!socketsWiredInThisBatch.has(targetSocket.location.id)) {
              const existingCables = t.entities.ofTypes("desktopAudioCable" as any, "desktopNoteCable" as any).get();
              for (const cable of existingCables) {
                const toSock = (cable.fields as any).toSocket;
                if (toSock && toSock.location && targetSocket.location) {
                  if (toSock.location.id === targetSocket.location.id || toSock.location === targetSocket.location) {
                    t.remove(cable.id);
                  }
                }
              }
              socketsWiredInThisBatch.add(targetSocket.location.id);
            }

            const newCable = t.create((cableType || "desktopAudioCable") as any, {
              fromSocket: sourceSocket.location,
              toSocket: targetSocket.location
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
      
      return {
        content: [{ type: "text", text: `Successfully wired ${connections.length} connections. Cable IDs: ${(modifyResult as any).cableIds.join(", ")}` }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to batch connect entities: ${err instanceof Error ? err.message : String(err)}` }],
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
