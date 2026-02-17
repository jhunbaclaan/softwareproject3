// required imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getLoginStatus, createAudiotoolClient, SyncedDocument } from "@audiotool/nexus";
import { TokenManager } from "./token-manager.js";

// creating server instance
const server = new McpServer({
    name: "nexus-mcp-server",
    version: "1.0.0",
});

// client, document reference, and token manager
let audiotoolClient: Awaited<ReturnType<typeof createAudiotoolClient>> | null = null;
let document: SyncedDocument | null = null;
let tokenManager: TokenManager | null = null;

// helper for authenticated client
async function getClient(){
    if(!audiotoolClient){
        const status = await getLoginStatus({
            clientId: process.env.AUDIOTOOL_CLIENT_ID || "",
            redirectUrl: process.env.AUDIOTOOL_REDIRECT_URL || "",
            scope: process.env.AUDIOTOOL_SCOPE || "",
        });
        // if not logged in, throws error
        if(!status.loggedIn){
            throw new Error("User not logged in. Log into Audiotool first.");
        }
        // create client if logged in
        audiotoolClient = await createAudiotoolClient({
            authorization: status
        });
    }

    return audiotoolClient;
}
// document helper with connection check
async function getDocument(): Promise<SyncedDocument> {
    if(!document){
        throw new Error("No document open. Use the 'initialize-session' tool to open a project first.");
    }

    // Quick connection check
    // Connection is guaranteed by initialize-session, but check anyway for safety
    if (!document.connected.getValue()) {
        throw new Error("Document is not connected. The connection may have been lost.");
    }

    return document;
}

// define tools
// initialize session with auth tokens and project
server.registerTool(
    "initialize-session",
    {
        description: "Initialize authenticated session with Audiotool using provided OIDC tokens and open a project document.",
        inputSchema: z.object({
            accessToken: z.string().describe("OIDC access token"),
            expiresAt: z.number().describe("Token expiration timestamp in milliseconds"),
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
            const { accessToken, expiresAt, refreshToken, clientId, redirectUrl, scope, projectUrl } = args;

            console.error("[initialize-session] Received args:", {
                clientId,
                redirectUrl,
                scope,
                projectUrl,
                hasAccessToken: !!accessToken,
                accessTokenLength: accessToken?.length,
                expiresAt,
                hasRefreshToken: !!refreshToken
            });

            // Create TokenManager for automatic token refresh
            console.error("[initialize-session] Creating TokenManager for automatic token refresh...");
            tokenManager = new TokenManager({
                accessToken,
                expiresAt,
                refreshToken,
                clientId,
            });

            // Use TokenManager with getToken() method for authorization
            // This allows the client to automatically refresh tokens as needed
            console.error("[initialize-session] Creating Audiotool client with TokenManager...");
            audiotoolClient = await createAudiotoolClient({
                authorization: tokenManager,
            });
            console.error("[initialize-session] Client created successfully!");

            // Create and start synced document
            console.error("[initialize-session] Creating synced document for project:", projectUrl);
            document = await audiotoolClient.createSyncedDocument({
                project: projectUrl,
            });
            console.error("[initialize-session] Document created, starting sync...");

            // Start document sync
            await document.start();
            console.error("[initialize-session] Document sync started, waiting for connection...");

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
    }
);

// open document tool (kept for backward compatibility)
server.registerTool(
    "open-document",
    {
        description: "Open an Audiotool document via project URL or ID.",
        inputSchema: z.object({
            projectURL: z.string().optional().describe("URL/ID of the Audiotool project to use"),
        }),
    },
    async (args: { projectURL?: string}) => {
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
                        text: projectURL ?
                        `Opened document for project: ${projectURL}`:
                        'Project opened successfully',
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
)
// add entity tool
server.registerTool(
    "add-entity",
    {
        description: "Add an entity to the Audiotool project. Valid entity types: 'heisenberg' (polyphonic synth), 'bassline' (monophonic synth), 'machinedrum' (drum machine), 'tonematrix' (step sequencer), 'stompboxDelay' (delay effect)",
        inputSchema: z.object({
            entityType: z.string().describe("Type of entity to add. Examples: 'heisenberg', 'bassline', 'machinedrum', 'tonematrix', 'stompboxDelay'"),
            properties: z.record(z.string(), z.any()).optional().describe("Properties for the entity"),
            x: z.number().describe("X position"),
            y: z.number().describe("Y position"),
        }),
    },
    async (args: { entityType: string, properties?: Record<string, any>, x?: number, y?: number }) => {
        try {
            const { entityType, properties, x, y } = args;
            console.error(`[add-entity] Adding ${entityType} at (${x}, ${y})...`);
            console.error(`[add-entity] Properties:`, JSON.stringify(properties || {}, null, 2));

            const doc = await getDocument();

            // Validate entity type (case-sensitive check)
            const validEntityTypes = ['heisenberg', 'bassline', 'machinedrum', 'tonematrix', 'stompboxDelay'];
            if (!validEntityTypes.includes(entityType)) {
                console.error(`[add-entity] Invalid entity type: ${entityType}. Valid types: ${validEntityTypes.join(', ')}`);
                throw new Error(`Invalid entity type: ${entityType}. Valid types: ${validEntityTypes.join(', ')}`);
            }

            // Modify document and create entity
            const result = await doc.modify((t) => {
                console.error(`[add-entity] Creating entity of type: ${entityType}`);

                // Merge position into properties if provided
                // Note: positionX and positionY are built-in properties on device entities
                const entityProperties = {
                    ...(properties || {}),
                    ...(x !== undefined && { positionX: x }),
                    ...(y !== undefined && { positionY: y })
                };

                console.error(`[add-entity] Final properties:`, JSON.stringify(entityProperties, null, 2));

                // Create the entity with properties (including position)
                const newEntity = t.create(entityType as any, entityProperties);

                console.error(`[add-entity] Entity created successfully:`, {
                    hasEntity: !!newEntity,
                    hasLocation: !!newEntity?.location,
                    entityType: newEntity?.entityType,
                    id: newEntity?.id
                });

                // Verify entity was created
                if (!newEntity) {
                    throw new Error(`Failed to create entity: t.create returned undefined`);
                }

                return newEntity;
            });

            console.error(`[add-entity] Successfully added ${entityType} with ID: ${result?.id}`);

            return {
                content: [
                    {
                        type: "text",
                        text: `Added ${entityType} at position (${x}, ${y}). Entity ID: ${result?.id}`,
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
            removeDependencies: z.boolean().optional().default(false).describe("If true, then any entities that depend/are connected to this one are also removed."),
        }),
    },
    async (args: { entityID: string, removeDependencies?: boolean }) => {
        try {
            const { entityID, removeDependencies } = args;
            console.error(`[remove-entity] Removing entity ${entityID}...`);

            const doc = await getDocument();

            await doc.modify((t) => {
                if (removeDependencies){
                    t.removeWithDependencies(entityID);
                }
                else t.remove(entityID);
            });

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
    }
);
// update entity value tool
// a 'value' refers to the entity's main parameters like delay, volume, etc.
server.registerTool(
    "update-entity-value",
    {
        description: "Update an entity's parameter/field value",
        inputSchema: z.object({
            entityID: z.string().describe("ID of the entity to update"),
            fieldName: z.string().describe("Name of the field to update (e.g., 'delayTime', 'feedback', 'isActive')"),
            value: z.union([z.string(), z.number(), z.boolean()]).describe("New value for the field"),
        }),
    },
    async (args: { entityID: string, fieldName: string, value: string | number | boolean }) => {
        const { entityID, fieldName, value } = args;
        const doc = await getDocument();

        await doc.modify((t) => {
            // Use getEntity to find the entity by ID
            const entity = t.entities.getEntity(entityID);
            if (!entity) {
                throw new Error(`Entity with ID ${entityID} not found`);
            }

            const field = (entity.fields as any)[fieldName];
            if (!field) {
                throw new Error(`Field '${fieldName}' not found on entity ${entityID}`);
            }

            t.update(field, value);
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Updated ${fieldName} of entity ${entityID} to ${value}`,
                },
            ],
        };
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
    async (args: { entityID: string, x: number, y: number }) => {
        const { entityID, x, y } = args;
        const doc = await getDocument();

        await doc.modify((t) => {
            // Find all desktop placements and filter for the one pointing to this entity
            // Cast to 'any' to bypass TypeScript's strict entity type checking
            const placements = t.entities.ofTypes("desktopPlacement" as any).get();
            const placement = placements.find(p => {
                const entityField = (p.fields as any).entity;
                return entityField?.value?.id === entityID;
            });

            if (!placement) {
                throw new Error(`Desktop placement for entity ${entityID} not found. Entity may not be placed on desktop.`);
            }

            t.update((placement.fields as any).x, x);
            t.update((placement.fields as any).y, y);
        });

        return {
            content: [
                {
                    type: "text",
                    text: `Moved entity ${entityID} to position (${x}, ${y})`,
                },
            ],
        };
    },
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);