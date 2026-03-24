import { describe, it, expect, vi, beforeEach } from 'vitest';
import { importAudioBlobToProject } from '../../audiotool/importGeneratedAudio';

describe('importGeneratedAudio tests', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  it('uploads blob and mutates document correctly', async () => {
    // Mock the binary upload PUT request
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK'
    } as Response);

    const fakeClient: any = {
      api: {
        sampleService: {
          createSample: vi.fn().mockResolvedValue({
            sample: { name: 'sample_id_123' },
            uploadEndpoint: { uploadUrl: 'http://fake-upload' }
          }),
          uploadSampleFinished: vi.fn().mockResolvedValue({}),
          getSample: vi.fn().mockResolvedValue({
            sample: { name: 'sample_id_123', wavUrl: 'fake.wav' }
          })
        }
      }
    };

    let documentModifications = 0;
    const fakeDoc: any = {
      modify: vi.fn().mockImplementation(async (callback) => {
        const t = {
          entities: {
            ofTypes: () => ({ getOne: () => null, get: () => [] }),
          },
          create: vi.fn().mockReturnValue({ location: 'fake_location', fields: {} }),
          update: vi.fn()
        };
        await callback(t);
        documentModifications++;
        // Assertions on t.create
        expect(t.create).toHaveBeenCalledWith('audioDevice', expect.anything());
        expect(t.create).toHaveBeenCalledWith('sample', expect.anything());
        expect(t.create).toHaveBeenCalledWith('audioTrack', expect.anything());
        expect(t.create).toHaveBeenCalledWith('audioRegion', expect.anything());
      })
    };

    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' });
    
    await importAudioBlobToProject(fakeClient, fakeDoc, blob, {
      displayName: 'Test audio file',
      durationMs: 5000,
    });

    expect(fakeClient.api.sampleService.createSample).toHaveBeenCalled();
    expect(fakeClient.api.sampleService.uploadSampleFinished).toHaveBeenCalledWith({ name: 'sample_id_123' });
    expect(fakeDoc.modify).toHaveBeenCalled();
    expect(documentModifications).toBe(1);
    expect(fetch).toHaveBeenCalledWith('http://fake-upload', expect.objectContaining({ method: 'PUT' }));
  });
});
