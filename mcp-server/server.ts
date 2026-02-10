// required imports
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getLoginStatus, createAudiotoolClient } from "@audiotool/nexus";

// creating server instance
const server = new McpServer({
    name: "nexus-mcp-server",
    version: "1.0.0",
});

// client reference
let audiotoolClient: Awaited<ReturnType<typeof createAudiotoolClient>> | null = null;

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

// define tools
// add entity tool
server.registerTool(
    "add-entity",
    {
        description: "Add an entity to the Audiotool project",
        inputSchema: z.object({
            entityType: z.string().describe("Type of entity to add (e.g., 'synth', 'drum-machine')"),
            x: z.number().describe("X position"),
            y: z.number().describe("Y position"),
        }),
    },
    async (args: { entityType: string, x: number, y: number }) => {
        const { entityType, x, y } = args;
        const client = await getClient();
        
        // implementation wip
        // e.g.: await client.document.addEntity({ type: entityType, position: { x, y } });
        
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
            entityId: z.string().describe("ID of the entity to remove"),
        }),
    },
    async (args: { entityId: string }) => {
        const { entityId } = args;
        const client = await getClient();
        
        // implementation wip
        // e.g.: await client.document.removeEntity({ id: entityId });
        
        return {
            content: [
                {
                    type: "text",
                    text: `Removed entity with ID ${entityId}`,
                },
            ],
        };
    }
);