// required imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getLoginStatus, createAudiotoolClient, SyncedDocument } from "@audiotool/nexus";

// creating server instance
const server = new McpServer({
    name: "nexus-mcp-server",
    version: "1.0.0",
});

// client, document reference
let audiotoolClient: Awaited<ReturnType<typeof createAudiotoolClient>> | null = null;
let document: SyncedDocument | null = null;

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
// document helper
async function getDocument(): Promise<SyncedDocument> {
    if(!document){
        throw new Error("No document open. Use the 'open-document' tool to open a project first.");
    }
    return document;
}

// define tools
// open document tool
server.registerTool(
    "open-document",
    {
        description: "Open an Audiotool document via project URL or ID.",
        inputSchema: z.object({
            projectURL: z.string().optional().describe("URL/ID of the Audiotool project to use"),
        }),
    },
    async (args: { projectURL?: string}) => {
        const { projectURL } = args;
        const client = await getClient();

        const document = await client.createSyncedDocument({
            project: projectURL || "",
        });
        await document.start();
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
    },
)
// add entity tool
server.registerTool(
    "add-entity",
    {
        description: "Add an entity to the Audiotool project",
        inputSchema: z.object({
            entityType: z.string().describe("Type of entity to add (e.g., 'synth', 'drum-machine')"),
            properties: z.record(z.string(), z.any()).optional().describe("Properties for the entity"),
            x: z.number().describe("X position"),
            y: z.number().describe("Y position"),
        }),
    },
    async (args: { entityType: string, properties?: Record<string, any>, x?: number, y?: number }) => {
        const { entityType, properties, x, y } = args;
        const doc = await getDocument();
        
        // implementation wip
        await doc.modify((t) => {
            const newEntity = t.create(entityType as any, properties ||{});
            // if position provided, then place on given coords
            if(x !== undefined && y !== undefined){
                t.create("desktopPlacement" as any, {
                    entity: newEntity.location,
                    x: x,
                    y: y
                })
            }
            return newEntity;
        });
        
        return {
            content: [
                {
                    type: "text",
                    text: `Added ${entityType} at position (${x}, ${y})`,
                },
            ],
        };
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
        const { entityID, removeDependencies } = args;
        const doc = await getDocument();

        // implementation wip
        await doc.modify((t) => {
            if (removeDependencies){
                t.removeWithDependencies(entityID);
            }
            else t.remove(entityID);
        });
        return {
            content: [
                {
                    type: "text",
                    text: `Removed entity with ID ${entityID}`,
                },
            ],
        };
    }
);

// Start the server
const transport = new StdioServerTransport();
await server.connect(transport);