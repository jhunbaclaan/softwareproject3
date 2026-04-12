import { beforeEach, describe, expect, it, vi } from "vitest";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const registeredTools = new Map<string, ToolHandler>();
const connectMock = vi.fn(async () => undefined);

const createAudiotoolClientMock = vi.fn();
const getLoginStatusMock = vi.fn();

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
  class MockMcpServer {
    registerTool(name: string, _meta: unknown, handler: ToolHandler) {
      registeredTools.set(name, handler);
    }
    connect = connectMock;
  }
  return { McpServer: MockMcpServer };
});

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => {
  class MockStdioServerTransport {}
  return { StdioServerTransport: MockStdioServerTransport };
});

vi.mock("@audiotool/nexus", () => {
  return {
    getLoginStatus: getLoginStatusMock,
    createAudiotoolClient: createAudiotoolClientMock,
  };
});

function makeMockDocument(configFields?: Record<string, unknown>, extraEntities?: Array<{ id: string; entityType: string; fields: Record<string, unknown> }>) {
  const updates: Array<{ field: unknown; value: unknown }> = [];
  const configEntity = configFields
    ? { fields: configFields }
    : undefined;

  const allEntities = [
    ...(configEntity ? [{ id: "config-1", entityType: "config", ...configEntity }] : []),
    ...(extraEntities ?? []),
  ];

  const doc = {
    connected: {
      getValue: () => true,
      subscribe: () => ({ terminate: () => undefined }),
    },
    events: {
      onCreate: () => ({ terminate: () => undefined }),
      onRemove: () => ({ terminate: () => undefined }),
    },
    queryEntities: {
      get: () => allEntities,
    },
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    modify: vi.fn(async (cb: (t: any) => unknown) => {
      const tx = {
        entities: {
          ofTypes: (type: string) => ({
            get: () => (type === "config" && configEntity ? [configEntity] : []),
          }),
        },
        update: (field: unknown, value: unknown) => {
          updates.push({ field, value });
        },
      };
      return cb(tx);
    }),
  };

  return { doc, updates };
}

async function loadServerWithDocument(document: ReturnType<typeof makeMockDocument>["doc"]) {
  registeredTools.clear();
  connectMock.mockClear();
  getLoginStatusMock.mockReset();
  createAudiotoolClientMock.mockReset();

  createAudiotoolClientMock.mockResolvedValue({
    createSyncedDocument: vi.fn(async () => document),
  });

  vi.resetModules();
  await import("../server.ts");

  const init = registeredTools.get("initialize-session");
  if (!init) throw new Error("initialize-session tool was not registered");
  await init({
    accessToken: "token",
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh",
    clientId: "client",
    redirectUrl: "http://localhost/cb",
    scope: "scope",
    projectUrl: "project-url",
  });
}

describe("MCP Server", () => {
  beforeEach(() => {
    registeredTools.clear();
    vi.clearAllMocks();
  });

  it("imports and connects without crashing", async () => {
    const { doc } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);
    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("registers update-project-config tool", async () => {
    const { doc } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);
    expect(registeredTools.has("update-project-config")).toBe(true);
  });

  it("updates tempo only", async () => {
    const { doc, updates } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);

    const handler = registeredTools.get("update-project-config");
    if (!handler) throw new Error("update-project-config tool missing");
    const result = await handler({ tempoBpm: 132 });

    expect(result.isError).toBeUndefined();
    expect(updates).toEqual([{ field: "tempoField", value: 132 }]);
  });

  it("updates tempo and time signature together", async () => {
    const { doc, updates } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);

    const handler = registeredTools.get("update-project-config");
    if (!handler) throw new Error("update-project-config tool missing");
    const result = await handler({
      tempoBpm: 128,
      timeSignatureNumerator: 3,
      timeSignatureDenominator: 4,
    });

    expect(result.isError).toBeUndefined();
    expect(updates).toEqual([
      { field: "tempoField", value: 128 },
      { field: "numField", value: 3 },
      { field: "denField", value: 4 },
    ]);
  });

  it("returns an error when no fields are provided", async () => {
    const { doc } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);

    const handler = registeredTools.get("update-project-config");
    if (!handler) throw new Error("update-project-config tool missing");
    const result = await handler({});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("At least one config field must be provided");
  });

  it("returns an error when only one time-signature part is provided", async () => {
    const { doc } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);

    const handler = registeredTools.get("update-project-config");
    if (!handler) throw new Error("update-project-config tool missing");
    const result = await handler({ timeSignatureNumerator: 7 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("must be provided together");
  });

  it("returns an error when config entity is missing", async () => {
    const { doc } = makeMockDocument();
    await loadServerWithDocument(doc);

    const handler = registeredTools.get("update-project-config");
    if (!handler) throw new Error("update-project-config tool missing");
    const result = await handler({ tempoBpm: 120 });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Config entity not found");
  });

  it("get-project-summary includes playerEntityId for audio tracks", async () => {
    const { doc } = makeMockDocument(
      {
        tempoBpm: { value: 120 },
        signatureNumerator: { value: 4 },
        signatureDenominator: { value: 4 },
      },
      [
        {
          id: "audio-device-1",
          entityType: "audioDevice",
          fields: {
            displayName: { value: "ElevenLabs clip" },
            positionX: { value: 80 },
            positionY: { value: 400 },
            audioOutput: { location: "audio-device-1/audioDevice/audioOutput" },
          },
        },
        {
          id: "audio-track-1",
          entityType: "audioTrack",
          fields: {
            displayName: { value: "Audio Track 1" },
            orderAmongTracks: { value: 0 },
            player: { value: { entityId: "audio-device-1", entityType: "audioDevice" } },
          },
        },
      ],
    );
    await loadServerWithDocument(doc);

    const handler = registeredTools.get("get-project-summary");
    if (!handler) throw new Error("get-project-summary tool missing");
    const result = await handler({});

    expect(result.isError).toBeUndefined();
    const summary = JSON.parse(result.content[0].text);

    expect(summary.audioTracks).toHaveLength(1);
    expect(summary.audioTracks[0].playerEntityId).toBe("audio-device-1");

    const audioDeviceInDevices = summary.devices.find(
      (d: any) => d.id === "audio-device-1",
    );
    expect(audioDeviceInDevices).toBeDefined();
    expect(audioDeviceInDevices.type).toBe("audioDevice");
  });
});
