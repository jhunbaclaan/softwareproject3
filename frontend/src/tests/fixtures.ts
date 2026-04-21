/**
 * Reusable mock factories and test data for frontend tests.
 */
import { vi } from 'vitest';
import type { AuthTokens, LLMProvider } from '../api';

export const mockAuthTokens: AuthTokens = {
  accessToken: 'test-access-token-123',
  expiresAt: Date.now() + 3600000,
  refreshToken: 'test-refresh-token-456',
  clientId: 'test-client-id',
};

export const mockProject = {
  name: 'projects/test-project-id',
  displayName: 'Test Project',
};

export const mockProjectList = [
  { name: 'projects/project-1', displayName: 'My First Song' },
  { name: 'projects/project-2', displayName: 'Dance Track' },
  { name: 'projects/project-3', displayName: 'Ambient Piece' },
];

export const mockAgentResponse = {
  reply: 'I added a bassline synth to your project.',
  trace: [
    { id: '1', label: 'add-entity', detail: 'Adding bassline', status: 'done' as const },
  ],
};

export const mockMusicResponse = {
  audio_base64: 'SGVsbG8gV29ybGQ=', // "Hello World" in base64
  format: 'mp3_44100_128',
  prompt: 'upbeat electronic beat',
};

export function createMockAudiotoolClient() {
  return {
    projects: {
      listProjects: vi.fn().mockResolvedValue({
        projects: mockProjectList,
        nextPageToken: '',
      }),
      createProject: vi.fn().mockResolvedValue({
        name: 'projects/new-project-id',
        displayName: 'New Project',
      }),
      updateProject: vi.fn().mockResolvedValue({}),
      deleteProject: vi.fn().mockResolvedValue({}),
    },
    samples: {
      createSample: vi.fn().mockResolvedValue({
        sample: { name: 'sample_id_123' },
        uploadEndpoint: { uploadUrl: 'http://fake-upload' },
      }),
      uploadSampleFinished: vi.fn().mockResolvedValue({}),
      getSample: vi.fn().mockResolvedValue({
        sample: { name: 'sample_id_123', wavUrl: 'fake.wav' },
      }),
    },
    presets: {
      get: vi.fn().mockResolvedValue({}),
    },
    open: vi.fn().mockResolvedValue(createMockSyncedDocument()),
  };
}

export function createMockSyncedDocument() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn(),
    modify: vi.fn().mockImplementation(async (callback: any) => {
      const t = {
        entities: {
          ofTypes: () => ({ getOne: () => null, get: () => [] }),
          getEntity: () => null,
        },
        create: vi.fn().mockReturnValue({ location: 'fake_location', fields: {}, id: 'fake-id' }),
        update: vi.fn(),
      };
      return callback(t);
    }),
    connected: {
      getValue: vi.fn().mockReturnValue(true),
      subscribe: vi.fn().mockReturnValue({ terminate: vi.fn() }),
    },
    queryEntities: {
      get: vi.fn().mockReturnValue([]),
    },
  };
}
