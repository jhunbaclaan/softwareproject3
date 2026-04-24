import { beforeEach, describe, expect, it, vi } from "vitest";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

const registeredTools = new Map<string, ToolHandler>();
const connectMock = vi.fn(async () => undefined);

const createAudiotoolClientMock = vi.fn();
const audiotoolMock = vi.fn();
const createServerAuthMock = vi.fn(() => ({ getToken: vi.fn(async () => "token") }));

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
    audiotool: audiotoolMock,
    createAudiotoolClient: createAudiotoolClientMock,
    createServerAuth: createServerAuthMock,
  };
});

vi.mock("@audiotool/nexus/node", () => {
  return {
    createNodeTransport: vi.fn(() => ({ mocked: "transport" })),
    createDiskWasmLoader: vi.fn(() => ({ mocked: "wasm-loader" })),
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

async function loadServerWithDocument(
  document: ReturnType<typeof makeMockDocument>["doc"],
  clientOverrides: Record<string, unknown> = {},
) {
  registeredTools.clear();
  connectMock.mockClear();
  audiotoolMock.mockReset();
  createAudiotoolClientMock.mockReset();
  createServerAuthMock.mockClear();

  createAudiotoolClientMock.mockResolvedValue({
    open: vi.fn(async () => document),
    ...clientOverrides,
  });

  vi.resetModules();
  await import("../server");

  const init = registeredTools.get("initialize-session");
  if (!init) throw new Error("initialize-session tool was not registered");
  await init({
    accessToken: "token",
    expiresAt: Date.now() + 60_000,
    refreshToken: "refresh",
    clientId: "client",
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

  it("initialize-session uses createServerAuth", async () => {
    const { doc } = makeMockDocument({
      tempoBpm: "tempoField",
      signatureNumerator: "numField",
      signatureDenominator: "denField",
    });
    await loadServerWithDocument(doc);

    expect(createServerAuthMock).toHaveBeenCalledTimes(1);
    expect(createServerAuthMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accessToken: "token",
        refreshToken: "refresh",
        clientId: "client",
      }),
    );
    expect(createAudiotoolClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        auth: createServerAuthMock.mock.results[0]?.value,
      }),
    );
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

  describe("connect-entities / disconnect-entities", () => {
    /**
     * Build a richer mock document whose `modify` transaction supports
     * getEntity/ofTypes/create/remove so we can exercise the connect and
     * disconnect cable-plumbing logic end-to-end.
     */
    function makeWiringDocument(initialEntities: Array<{
      id: string;
      entityType: string;
      fields: Record<string, unknown>;
    }>) {
      const entityMap = new Map<string, any>(
        initialEntities.map((e) => [e.id, { ...e, type: e.entityType }]),
      );
      let nextId = 1;

      const buildTx = () => ({
        entities: {
          getEntity: (id: string) => entityMap.get(id),
          ofTypes: (...types: string[]) => ({
            get: () =>
              Array.from(entityMap.values()).filter((e) =>
                types.includes(e.entityType),
              ),
          }),
        },
        create: (type: string, fields: Record<string, unknown>) => {
          const id = `cable-${nextId++}`;
          const entity = {
            id,
            entityType: type,
            type,
            fields: {
              fromSocket: { value: fields.fromSocket, location: `${id}/fromSocket` },
              toSocket: { value: fields.toSocket, location: `${id}/toSocket` },
            },
          };
          entityMap.set(id, entity);
          return entity;
        },
        remove: (id: string) => {
          entityMap.delete(id);
        },
      });

      const doc = {
        connected: {
          getValue: () => true,
          subscribe: () => ({ terminate: () => undefined }),
        },
        events: {
          onCreate: () => ({ terminate: () => undefined }),
          onRemove: () => ({ terminate: () => undefined }),
        },
        queryEntities: { get: () => Array.from(entityMap.values()) },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        modify: vi.fn(async (cb: (t: any) => unknown) => cb(buildTx())),
      };

      return { doc, entityMap };
    }

    /** Build a NexusLocation-ish object whose `.equals` matches by string form. */
    function makeSocketLocation(key: string) {
      return {
        toString: () => key,
        equals: (other: unknown) =>
          other != null && String(other) === key,
      };
    }

    it("connect-entities rewires an already-wired input (old cable removed, exactly one cable remains)", async () => {
      const synthLoc = makeSocketLocation("synth-1/audioOutput");
      const synth2Loc = makeSocketLocation("synth-2/audioOutput");
      const channelLoc = makeSocketLocation("channel-1/audioInput");

      const { doc, entityMap } = makeWiringDocument([
        {
          id: "synth-1",
          entityType: "heisenberg",
          fields: {
            audioOutput: {
              location: synthLoc,
              fields: {},
            },
          },
        },
        {
          id: "synth-2",
          entityType: "heisenberg",
          fields: {
            audioOutput: {
              location: synth2Loc,
              fields: {},
            },
          },
        },
        {
          id: "channel-1",
          entityType: "mixerChannel",
          fields: {
            audioInput: {
              location: channelLoc,
              fields: {},
            },
          },
        },
        {
          id: "old-cable",
          entityType: "desktopAudioCable",
          fields: {
            fromSocket: { value: synthLoc, location: "old-cable/fromSocket" },
            toSocket: { value: channelLoc, location: "old-cable/toSocket" },
          },
        },
      ]);

      await loadServerWithDocument(doc);
      const handler = registeredTools.get("connect-entities");
      if (!handler) throw new Error("connect-entities tool missing");

      const result = await handler({
        sourceEntityId: "synth-2",
        sourceField: "audioOutput",
        targetEntityId: "channel-1",
        targetField: "audioInput",
      });

      expect(result.isError).toBeUndefined();
      expect(entityMap.has("old-cable")).toBe(false);
      const remainingCables = Array.from(entityMap.values()).filter(
        (e) => e.entityType === "desktopAudioCable",
      );
      expect(remainingCables).toHaveLength(1);
      expect(String(remainingCables[0].fields.toSocket.value)).toBe(
        "channel-1/audioInput",
      );
    });

    it("connect-entities rejects a non-socket targetField with a clear error and does NOT create a cable", async () => {
      const { doc, entityMap } = makeWiringDocument([
        {
          id: "synth-1",
          entityType: "heisenberg",
          fields: {
            audioOutput: {
              location: makeSocketLocation("synth-1/audioOutput"),
              fields: {},
            },
          },
        },
        {
          id: "channel-1",
          entityType: "mixerChannel",
          fields: {
            displayName: { value: "Lead", location: "channel-1/displayName" },
          },
        },
      ]);

      await loadServerWithDocument(doc);
      const handler = registeredTools.get("connect-entities");
      if (!handler) throw new Error("connect-entities tool missing");

      const result = await handler({
        sourceEntityId: "synth-1",
        sourceField: "audioOutput",
        targetEntityId: "channel-1",
        targetField: "displayName",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not a valid audio/note socket");
      expect(
        Array.from(entityMap.values()).some(
          (e) => e.entityType === "desktopAudioCable",
        ),
      ).toBe(false);
    });

    it("disconnect-entities is idempotent for already-removed ids", async () => {
      const { doc, entityMap } = makeWiringDocument([
        {
          id: "cable-existing",
          entityType: "desktopAudioCable",
          fields: {
            fromSocket: { value: "x", location: "cable-existing/fromSocket" },
            toSocket: { value: "y", location: "cable-existing/toSocket" },
          },
        },
      ]);

      await loadServerWithDocument(doc);
      const handler = registeredTools.get("disconnect-entities");
      if (!handler) throw new Error("disconnect-entities tool missing");

      const result = await handler({
        cableIds: ["cable-existing", "cable-gone"],
      });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain("Disconnected 1 cable(s)");
      expect(result.content[0].text).toContain("cable-gone");
      expect(entityMap.has("cable-existing")).toBe(false);
    });
  });

  describe("list-presets / apply-preset", () => {
    it("list-presets returns trimmed preset payload and respects limit", async () => {
      const listMock = vi.fn(async () => [
        { meta: { id: "presets/1", name: "Wide Lead", description: "A wide lead" } },
        { meta: { id: "presets/2", name: "Fat Bass", description: "A fat bass" } },
        { meta: { id: "presets/3", name: "Dark Pad", description: "A dark pad" } },
      ]);

      const { doc } = makeMockDocument({
        tempoBpm: "tempoField",
        signatureNumerator: "numField",
        signatureDenominator: "denField",
      });
      await loadServerWithDocument(doc, {
        presets: {
          search: listMock,
          get: vi.fn(),
        },
      });

      const handler = registeredTools.get("list-presets");
      if (!handler) throw new Error("list-presets tool missing");

      const result = await handler({
        deviceType: "heisenberg",
        textSearch: "lead",
        limit: 2,
      });

      expect(result.isError).toBeUndefined();
      expect(listMock).toHaveBeenCalledWith("heisenberg", "lead");
      const payload = JSON.parse(result.content[0].text);
      expect(payload.deviceType).toBe("heisenberg");
      expect(payload.count).toBe(2);
      expect(payload.presets).toHaveLength(2);
      expect(payload.presets[0]).toEqual(
        expect.objectContaining({ id: "presets/1", name: "Wide Lead" }),
      );
    });

    it("list-presets returns an isError result when preset listing fails", async () => {
      const listMock = vi.fn(async () => {
        throw new Error("preset service down");
      });

      const { doc } = makeMockDocument({
        tempoBpm: "tempoField",
        signatureNumerator: "numField",
        signatureDenominator: "denField",
      });
      await loadServerWithDocument(doc, {
        presets: {
          search: listMock,
          get: vi.fn(),
        },
      });

      const handler = registeredTools.get("list-presets");
      if (!handler) throw new Error("list-presets tool missing");

      const result = await handler({ deviceType: "heisenberg" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Failed to list presets");
      expect(result.content[0].text).toContain("preset service down");
    });

    it("apply-preset applies the fetched preset to an existing entity", async () => {
      const entity = { id: "synth-1", entityType: "heisenberg", fields: {} };
      const applied: Array<{ entity: unknown; preset: unknown }> = [];
      const preset = { meta: { id: "presets/42" } };
      const getMock = vi.fn(async () => preset);

      const doc = {
        connected: {
          getValue: () => true,
          subscribe: () => ({ terminate: () => undefined }),
        },
        events: {
          onCreate: () => ({ terminate: () => undefined }),
          onRemove: () => ({ terminate: () => undefined }),
        },
        queryEntities: { get: () => [entity] },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        modify: vi.fn(async (cb: (t: any) => unknown) =>
          cb({
            entities: {
              getEntity: (id: string) => (id === "synth-1" ? entity : undefined),
            },
            applyPresetTo: (target: unknown, incomingPreset: unknown) => {
              applied.push({ entity: target, preset: incomingPreset });
            },
          }),
        ),
      };

      await loadServerWithDocument(doc as any, {
        presets: {
          list: vi.fn(),
          get: getMock,
        },
      });

      const handler = registeredTools.get("apply-preset");
      if (!handler) throw new Error("apply-preset tool missing");

      const result = await handler({
        entityID: "synth-1",
        presetID: "presets/42",
      });

      expect(result.isError).toBeUndefined();
      expect(getMock).toHaveBeenCalledWith("presets/42");
      expect(applied).toHaveLength(1);
      expect(result.content[0].text).toContain("Applied preset presets/42 to entity synth-1");
    });

    it("apply-preset returns an isError result when entity is missing", async () => {
      const getMock = vi.fn(async () => ({ meta: { id: "presets/42" } }));
      const doc = {
        connected: {
          getValue: () => true,
          subscribe: () => ({ terminate: () => undefined }),
        },
        events: {
          onCreate: () => ({ terminate: () => undefined }),
          onRemove: () => ({ terminate: () => undefined }),
        },
        queryEntities: { get: () => [] },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        modify: vi.fn(async (cb: (t: any) => unknown) =>
          cb({
            entities: {
              getEntity: () => undefined,
            },
            applyPresetTo: vi.fn(),
          }),
        ),
      };

      await loadServerWithDocument(doc as any, {
        presets: {
          list: vi.fn(),
          get: getMock,
        },
      });

      const handler = registeredTools.get("apply-preset");
      if (!handler) throw new Error("apply-preset tool missing");

      const result = await handler({
        entityID: "missing-entity",
        presetID: "presets/42",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Failed to apply preset");
      expect(result.content[0].text).toContain("missing-entity");
    });

    it("apply-preset resolves instrumentSlug via client.presets.getInstrument", async () => {
      const entity = { id: "gakki-1", entityType: "gakki", fields: {} };
      const applied: Array<{ entity: unknown; preset: unknown }> = [];
      const violinPreset = { meta: { id: "presets/violin-uuid" } };
      const getInstrumentMock = vi.fn(async () => violinPreset);
      const getDrumsMock = vi.fn();

      const doc = {
        connected: {
          getValue: () => true,
          subscribe: () => ({ terminate: () => undefined }),
        },
        events: {
          onCreate: () => ({ terminate: () => undefined }),
          onRemove: () => ({ terminate: () => undefined }),
        },
        queryEntities: { get: () => [entity] },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        modify: vi.fn(async (cb: (t: any) => unknown) =>
          cb({
            entities: {
              getEntity: (id: string) => (id === "gakki-1" ? entity : undefined),
            },
            applyPresetTo: (target: unknown, incomingPreset: unknown) => {
              applied.push({ entity: target, preset: incomingPreset });
            },
          }),
        ),
      };

      await loadServerWithDocument(doc as any, {
        presets: {
          get: vi.fn(),
          getInstrument: getInstrumentMock,
          getDrums: getDrumsMock,
        },
      });

      const handler = registeredTools.get("apply-preset");
      if (!handler) throw new Error("apply-preset tool missing");

      // "violin" is already a canonical GmInstrumentSlug so it passes straight through.
      const result = await handler({
        entityID: "gakki-1",
        instrumentSlug: "violin",
      });

      expect(result.isError).toBeUndefined();
      expect(getInstrumentMock).toHaveBeenCalledWith("violin");
      expect(getDrumsMock).not.toHaveBeenCalled();
      expect(applied).toEqual([{ entity, preset: violinPreset }]);
      expect(result.content[0].text).toContain("GM instrument 'violin'");
      expect(result.content[0].text).toContain("gakki-1");
    });

    it("apply-preset resolves drumKitSlug synonyms via client.presets.getDrums", async () => {
      const entity = { id: "gakki-drums", entityType: "gakki", fields: {} };
      const applied: Array<{ entity: unknown; preset: unknown }> = [];
      const jazzKitPreset = { meta: { id: "presets/jazz-kit-uuid" } };
      const getDrumsMock = vi.fn(async () => jazzKitPreset);

      const doc = {
        connected: {
          getValue: () => true,
          subscribe: () => ({ terminate: () => undefined }),
        },
        events: {
          onCreate: () => ({ terminate: () => undefined }),
          onRemove: () => ({ terminate: () => undefined }),
        },
        queryEntities: { get: () => [entity] },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        modify: vi.fn(async (cb: (t: any) => unknown) =>
          cb({
            entities: {
              getEntity: (id: string) => (id === "gakki-drums" ? entity : undefined),
            },
            applyPresetTo: (target: unknown, incomingPreset: unknown) => {
              applied.push({ entity: target, preset: incomingPreset });
            },
          }),
        ),
      };

      await loadServerWithDocument(doc as any, {
        presets: {
          get: vi.fn(),
          getInstrument: vi.fn(),
          getDrums: getDrumsMock,
        },
      });

      const handler = registeredTools.get("apply-preset");
      if (!handler) throw new Error("apply-preset tool missing");

      // "jazz" is a synonym of the canonical "jazz-kit" slug.
      const result = await handler({
        entityID: "gakki-drums",
        drumKitSlug: "jazz",
      });

      expect(result.isError).toBeUndefined();
      expect(getDrumsMock).toHaveBeenCalledWith("jazz-kit");
      expect(applied).toEqual([{ entity, preset: jazzKitPreset }]);
      expect(result.content[0].text).toContain("GM drum kit 'jazz-kit'");
    });

    it("apply-preset rejects when no slug or preset id is provided", async () => {
      const { doc } = makeMockDocument({
        tempoBpm: "tempoField",
        signatureNumerator: "numField",
        signatureDenominator: "denField",
      });
      await loadServerWithDocument(doc, {
        presets: {
          get: vi.fn(),
          getInstrument: vi.fn(),
          getDrums: vi.fn(),
        },
      });

      const handler = registeredTools.get("apply-preset");
      if (!handler) throw new Error("apply-preset tool missing");

      const result = await handler({ entityID: "anything" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Exactly one of presetID");
    });

    it("apply-preset rejects an unknown instrumentSlug before hitting the SDK", async () => {
      const getInstrumentMock = vi.fn();
      const { doc } = makeMockDocument({
        tempoBpm: "tempoField",
        signatureNumerator: "numField",
        signatureDenominator: "denField",
      });
      await loadServerWithDocument(doc, {
        presets: {
          get: vi.fn(),
          getInstrument: getInstrumentMock,
          getDrums: vi.fn(),
        },
      });

      const handler = registeredTools.get("apply-preset");
      if (!handler) throw new Error("apply-preset tool missing");

      const result = await handler({
        entityID: "gakki-1",
        instrumentSlug: "definitely-not-an-instrument",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Unknown GM instrument slug");
      expect(getInstrumentMock).not.toHaveBeenCalled();
    });
  });

  describe("add-entity preset-aware flow", () => {
    function makeGakkiDoc() {
      const createdEntities: Array<{ type: string; id: string; fromPreset: unknown }> = [];
      const updates: Array<{ field: string; value: unknown }> = [];
      let idCounter = 0;

      const makeField = (name: string) => ({
        value: undefined as unknown,
        // Use a stable sentinel so t.update can identify which field was written.
        __name: name,
      });

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
          get: () => [],
          ofTypes: () => [],
        },
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        modify: vi.fn(async (cb: (t: any) => unknown) => {
          const tx = {
            entities: {
              ofTypes: () => ({ get: () => [] }),
              getEntity: () => undefined,
            },
            createDeviceFromPreset: (preset: unknown) => {
              idCounter += 1;
              const entity = {
                id: `gakki-${idCounter}`,
                entityType: "gakki",
                fields: {
                  positionX: makeField("positionX"),
                  positionY: makeField("positionY"),
                  displayName: makeField("displayName"),
                  gain: makeField("gain"),
                },
              };
              createdEntities.push({ type: "gakki", id: entity.id, fromPreset: preset });
              return entity;
            },
            create: vi.fn(() => ({
              id: "should-not-be-called",
              entityType: "unexpected",
              fields: {},
            })),
            update: (field: any, value: unknown) => {
              updates.push({ field: field?.__name ?? "unknown", value });
            },
          };
          return cb(tx);
        }),
      };

      return { doc, createdEntities, updates };
    }

    it("creating a gakki with entityType='violin' loads the violin preset atomically", async () => {
      const violinPreset = { meta: { id: "presets/violin-uuid" }, device: "gakki" };
      const getInstrumentMock = vi.fn(async () => violinPreset);
      const getDrumsMock = vi.fn();

      const { doc, createdEntities, updates } = makeGakkiDoc();
      await loadServerWithDocument(doc as any, {
        presets: {
          get: vi.fn(),
          getInstrument: getInstrumentMock,
          getDrums: getDrumsMock,
        },
      });

      const handler = registeredTools.get("add-entity");
      if (!handler) throw new Error("add-entity tool missing");

      const result = await handler({ entityType: "violin" });

      expect(result.isError).toBeUndefined();
      expect(getInstrumentMock).toHaveBeenCalledWith("violin");
      expect(getDrumsMock).not.toHaveBeenCalled();
      expect(createdEntities).toHaveLength(1);
      expect(createdEntities[0]).toEqual(
        expect.objectContaining({ type: "gakki", fromPreset: violinPreset }),
      );
      // createDeviceFromPreset + position/displayName/gain follow-up updates all
      // happened inside a single modify() call.
      expect(doc.modify).toHaveBeenCalledTimes(1);
      const fieldsWritten = updates.map((u) => u.field);
      expect(fieldsWritten).toEqual(
        expect.arrayContaining(["positionX", "positionY", "displayName", "gain"]),
      );
      expect(result.content[0].text).toContain("Added gakki");
    });

    it("creating a gakki with drumKit='jazz' loads the jazz-kit preset", async () => {
      const jazzKit = { meta: { id: "presets/jazz-kit-uuid" } };
      const getInstrumentMock = vi.fn();
      const getDrumsMock = vi.fn(async () => jazzKit);

      const { doc, createdEntities } = makeGakkiDoc();
      await loadServerWithDocument(doc as any, {
        presets: {
          get: vi.fn(),
          getInstrument: getInstrumentMock,
          getDrums: getDrumsMock,
        },
      });

      const handler = registeredTools.get("add-entity");
      if (!handler) throw new Error("add-entity tool missing");

      const result = await handler({
        entityType: "gakki",
        drumKit: "jazz",
      });

      expect(result.isError).toBeUndefined();
      expect(getDrumsMock).toHaveBeenCalledWith("jazz-kit");
      expect(getInstrumentMock).not.toHaveBeenCalled();
      expect(createdEntities).toHaveLength(1);
      expect(createdEntities[0].fromPreset).toBe(jazzKit);
    });
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
