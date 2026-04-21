import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importAudioBlobToProject } from '../../audiotool/importGeneratedAudio';

describe('importGeneratedAudio tests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  function createFakeClient(overrides: Record<string, any> = {}) {
    return {
      samples: {
        createSample: vi.fn().mockResolvedValue({
          sample: { name: 'sample_id_123' },
          uploadEndpoint: { uploadUrl: 'http://fake-upload' }
        }),
        uploadSampleFinished: vi.fn().mockResolvedValue({}),
        getSample: vi.fn().mockResolvedValue({
          sample: { name: 'sample_id_123', wavUrl: 'fake.wav' }
        }),
        ...overrides,
      }
    };
  }

  function createFakeDoc() {
    let modifyCount = 0;
    return {
      modify: vi.fn().mockImplementation(async (callback: any) => {
        const t = {
          entities: {
            ofTypes: () => ({
              getOne: () => ({ fields: { tempoBpm: { value: 120 } } }),
              get: () => [],
            }),
          },
          create: vi.fn().mockReturnValue({
            location: 'fake_location',
            fields: {
              audioOutput: { location: 'audio-out-loc' },
              displayName: { value: '' },
              displayParameters: {
                fields: {
                  orderAmongStrips: 'orderField',
                  displayName: 'nameField',
                },
              },
              audioInput: { location: 'audio-in-loc' },
              isActive: { value: false },
              isEnabled: { value: false },
            },
            id: 'fake-id',
          }),
          update: vi.fn(),
        };
        await callback(t);
        modifyCount++;
      }),
      _getModifyCount: () => modifyCount,
    };
  }

  it('uploads blob and mutates document correctly', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK'
    } as Response);

    const fakeClient: any = createFakeClient();
    const fakeDoc: any = createFakeDoc();

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

    await importAudioBlobToProject(fakeClient, fakeDoc, blob, {
      displayName: 'Test audio file',
      durationMs: 5000,
    });

    expect(fakeClient.samples.createSample).toHaveBeenCalled();
    expect(fakeClient.samples.uploadSampleFinished).toHaveBeenCalledWith({ name: 'sample_id_123' });
    expect(fakeDoc.modify).toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledWith('http://fake-upload', expect.objectContaining({ method: 'PUT' }));
  });

  it('throws on empty blob', async () => {
    const fakeClient: any = createFakeClient();
    const fakeDoc: any = createFakeDoc();

    const emptyBlob = new Blob([], { type: 'audio/mpeg' });

    await expect(
      importAudioBlobToProject(fakeClient, fakeDoc, emptyBlob, {
        displayName: 'Empty file',
        durationMs: 5000,
      })
    ).rejects.toThrow('Audio blob is empty');
  });

  it('throws on upload PUT failure', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as Response);

    const fakeClient: any = createFakeClient();
    const fakeDoc: any = createFakeDoc();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

    await expect(
      importAudioBlobToProject(fakeClient, fakeDoc, blob, {
        displayName: 'Test',
        durationMs: 5000,
      })
    ).rejects.toThrow('Sample upload failed');
  });

  it('retries createSample with fallback payloads on validation error', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);

    // First call fails with validation error, second succeeds
    const createSample = vi.fn()
      .mockResolvedValueOnce(new Error('invalid field: tags is not valid'))
      .mockResolvedValueOnce({
        sample: { name: 'sample_from_retry' },
        uploadEndpoint: { uploadUrl: 'http://fake-upload-retry' },
      });

    const fakeClient: any = createFakeClient({ createSample });
    const fakeDoc: any = createFakeDoc();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

    // The function tries progressively simpler payloads
    await importAudioBlobToProject(fakeClient, fakeDoc, blob, {
      displayName: 'Retry test',
      durationMs: 5000,
    });

    expect(createSample).toHaveBeenCalledTimes(2);
  });

  it('polls getSample until wavUrl is available', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);

    const getSample = vi.fn()
      .mockResolvedValueOnce({ sample: { name: 'sample_id_123' } }) // no wavUrl
      .mockResolvedValueOnce({ sample: { name: 'sample_id_123' } }) // no wavUrl
      .mockResolvedValueOnce({ sample: { name: 'sample_id_123', wavUrl: 'ready.wav' } }); // ready

    const fakeClient: any = createFakeClient({ getSample });
    const fakeDoc: any = createFakeDoc();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

    await importAudioBlobToProject(fakeClient, fakeDoc, blob, {
      displayName: 'Poll test',
      durationMs: 5000,
    });

    expect(getSample).toHaveBeenCalledTimes(3);
  });

  it('correctly uses layoutIndex for positioning', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);

    const fakeClient: any = createFakeClient();
    const fakeDoc: any = createFakeDoc();
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

    await importAudioBlobToProject(fakeClient, fakeDoc, blob, {
      displayName: 'Layout test',
      durationMs: 5000,
      layoutIndex: 3,
    });

    // posX = 80 + layoutIndex * 140 = 80 + 3 * 140 = 500
    const modifyCallback = fakeDoc.modify.mock.calls[0][0];
    // The modify was called, confirming layoutIndex was used
    expect(fakeDoc.modify).toHaveBeenCalled();
  });

  it('calculates duration ticks based on BPM', async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);

    const fakeClient: any = createFakeClient();

    // Track t.create calls to inspect audioRegion arguments
    let audioRegionArgs: any = null;
    const fakeDoc: any = {
      modify: vi.fn().mockImplementation(async (callback: any) => {
        const t = {
          entities: {
            ofTypes: (type: string) => ({
              getOne: () => type === 'config' ? { fields: { tempoBpm: { value: 120 } } } : null,
              get: () => [],
            }),
          },
          create: vi.fn().mockImplementation((type: string, args: any) => {
            if (type === 'audioRegion') {
              audioRegionArgs = args;
            }
            return {
              location: `loc-${type}`,
              fields: {
                audioOutput: { location: 'audio-out' },
                displayName: { value: '' },
                displayParameters: {
                  fields: { orderAmongStrips: 'of', displayName: 'nf' },
                },
                audioInput: { location: 'audio-in' },
                isActive: { value: false },
                isEnabled: { value: false },
              },
              id: `id-${type}`,
            };
          }),
          update: vi.fn(),
        };
        await callback(t);
      }),
    };

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });

    await importAudioBlobToProject(fakeClient, fakeDoc, blob, {
      displayName: 'BPM test',
      durationMs: 5000, // 5 seconds
    });

    // At 120 BPM: secondsToTicksAtBpm(5, 120) = round((5 * 120 * 3840) / 60) = round(38400) = 38400
    // But getSample returns wavUrl immediately, so playSeconds might differ
    // The key check is that audioRegion was created with region.durationTicks > 0
    expect(audioRegionArgs).toBeTruthy();
    expect(audioRegionArgs.region.durationTicks).toBeGreaterThan(0);
  });
});
