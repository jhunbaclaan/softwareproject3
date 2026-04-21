import type { AudiotoolClient, SyncedDocument } from '@audiotool/nexus';

/** Same tick basis as MCP server (1 quarter note = 3840 ticks). */
const TICKS_QUARTER = 3840;

/** Match Audiotool timeline math (see VideoAudioImporter). */
function secondsToTicksAtBpm(seconds: number, bpm: number): number {
  return Math.round((seconds * bpm * TICKS_QUARTER) / 60);
}

/**
 * Audiotool rejects CreateSample without this scope. See VideoAudioImporter / developer app settings.
 * https://github.com/TrumanOakes/VideoAudioImporter/blob/cursor/ui-visual-improvements-0890/src/main.js
 */
const SAMPLE_WRITE_SCOPE_HINT =
  ' Add sample:write to your Audiotool OAuth app, set VITE_AUDIOTOOL_SCOPE to "project:write sample:write", then log out and log in again.';

const MIXER_STRIP_TYPES = [
  'mixerChannel',
  'mixerGroup',
  'mixerAux',
  'mixerReverbAux',
  'mixerDelayAux',
] as const;

function isGrpcErrorResult(r: unknown): r is Error {
  return r instanceof Error;
}

function formatApiError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function isLikelyValidationErrorText(detail: string): boolean {
  const t = detail.toLowerCase();
  return (
    t.includes('invalid') ||
    t.includes('validation') ||
    t.includes('required') ||
    t.includes('malformed') ||
    t.includes('field')
  );
}

function isLikelyScopeOrPermissionText(detail: string): boolean {
  const t = detail.toLowerCase();
  return (
    t.includes('permission') ||
    t.includes('forbidden') ||
    t.includes('unauth') ||
    t.includes('denied') ||
    t.includes('scope')
  );
}

/**
 * Try progressively smaller CreateSample payloads (matches VideoAudioImporter pattern).
 * sampleType 1 = ONE_SHOT (their importer uses this for uploaded clips).
 */
async function createSampleWithFallbacks(
  client: AudiotoolClient,
  displayName: string,
): Promise<{ sample: { name: string }; uploadEndpoint: { uploadUrl: string; headers?: Record<string, string> } }> {
  const sampleDisplayName = displayName.trim().slice(0, 500) || 'Generated clip';

  const candidates: Array<{ label: string; request: { sample: Record<string, unknown> } }> = [
    {
      label: 'displayName+description+sampleType+usage+tags',
      request: {
        sample: {
          displayName: sampleDisplayName,
          description: 'Imported from Nexus Agent (e.g. ElevenLabs)',
          sampleType: 1,
          usage: 2,
          tags: ['elevenlabs', 'nexus-agent'],
        },
      },
    },
    {
      label: 'displayName+sampleType+usage',
      request: {
        sample: {
          displayName: sampleDisplayName,
          sampleType: 1,
          usage: 2,
        },
      },
    },
    {
      label: 'displayName-only',
      request: {
        sample: {
          displayName: sampleDisplayName,
        },
      },
    },
    {
      label: 'empty-sample',
      request: { sample: {} },
    },
  ];

  let lastDetail = 'CreateSample failed for unknown reason.';

  for (let i = 0; i < candidates.length; i++) {
    const { label, request } = candidates[i];
    console.log(`[createSample] Trying candidate ${i} (${label})…`);
    const result = await client.samples.createSample(request as any);

    if (!isGrpcErrorResult(result)) {
      const sample = result.sample;
      const uploadEndpoint = result.uploadEndpoint;
      if (sample?.name && uploadEndpoint?.uploadUrl) {
        console.log(`[createSample] Success with candidate ${i} (${label}), sample: ${sample.name}`);
        return { sample: { name: sample.name }, uploadEndpoint };
      }
      lastDetail = 'CreateSample returned no sample name or upload URL.';
      console.warn(`[createSample] Candidate ${i} returned OK but missing name/uploadUrl`, result);
      continue;
    }

    const errObj = result as any;
    console.error(`[createSample] Candidate ${i} (${label}) failed:`, {
      message: errObj.message,
      code: errObj.code,
      details: errObj.details,
      metadata: errObj.metadata,
      name: errObj.name,
      stack: errObj.stack,
    });
    lastDetail = formatApiError(result);
    if (isLikelyValidationErrorText(lastDetail) && i < candidates.length - 1) {
      continue;
    }
    break;
  }

  const isGenericSdkError = lastDetail.includes('.createSample threw error');
  const scopeHint = (isGenericSdkError || isLikelyScopeOrPermissionText(lastDetail))
    ? SAMPLE_WRITE_SCOPE_HINT
    : '';
  throw new Error(`${lastDetail}${scopeHint}`);
}

function connectAudioDeviceToStagebox(t: any, device: any): void {
  const outputField = device.fields?.audioOutput;
  if (!outputField?.location) return;

  const existingStrips = MIXER_STRIP_TYPES.flatMap((ty) =>
    t.entities.ofTypes(ty as any).get(),
  );
  const maxOrder = existingStrips.reduce((max: number, s: any) => {
    const order = s.fields?.displayParameters?.fields?.orderAmongStrips?.value ?? 0;
    return Math.max(max, order);
  }, -1);
  const nextOrder = maxOrder + 1;

  const deviceDisplayName = device.fields?.displayName?.value ?? '';
  const channelLabel = deviceDisplayName || `Audio ${nextOrder}`;

  const mixerChannel = t.create('mixerChannel' as any, {});
  if (!mixerChannel) return;

  const displayParams = mixerChannel.fields?.displayParameters;
  if (displayParams?.fields) {
    t.update(displayParams.fields.orderAmongStrips, nextOrder);
    t.update(displayParams.fields.displayName, channelLabel);
  }

  const inputLocation = mixerChannel.fields?.audioInput?.location;
  if (!inputLocation) return;

  t.create('desktopAudioCable' as any, {
    fromSocket: outputField.location,
    toSocket: inputLocation,
  });
}

function durationSecondsFromProtobuf(d: { seconds?: bigint | number; nanos?: number } | undefined): number {
  if (!d) return 0;
  const s = typeof d.seconds === 'bigint' ? Number(d.seconds) : Number(d.seconds ?? 0);
  const n = Number(d.nanos ?? 0) / 1e9;
  return s + n;
}

/**
 * Upload audio bytes to Audiotool samples, then add an audio track + region on the timeline.
 * Pattern aligned with https://github.com/TrumanOakes/VideoAudioImporter
 */
export async function importAudioBlobToProject(
  client: AudiotoolClient,
  doc: SyncedDocument,
  audioBlob: Blob,
  options: { displayName: string; durationMs: number; layoutIndex?: number },
): Promise<void> {
  const bytes = new Uint8Array(await audioBlob.arrayBuffer());
  if (bytes.length === 0) {
    throw new Error('Audio blob is empty.');
  }

  const label = options.displayName.trim().slice(0, 500) || 'Generated clip';

  const { sample: apiSample, uploadEndpoint: endpoint } = await createSampleWithFallbacks(client, label);

  const putHeaders = new Headers();
  for (const [headerName, headerValue] of Object.entries(endpoint.headers ?? {})) {
    if (headerName.toLowerCase() === 'host') {
      continue;
    }
    putHeaders.set(headerName, headerValue);
  }

  const putRes = await fetch(endpoint.uploadUrl, {
    method: 'PUT',
    headers: putHeaders,
    body: bytes,
  });
  if (!putRes.ok) {
    throw new Error(`Sample upload failed: HTTP ${putRes.status} ${putRes.statusText}`);
  }

  const finRes = await client.samples.uploadSampleFinished({
    name: apiSample.name,
  });
  if (isGrpcErrorResult(finRes)) {
    throw finRes;
  }

  let playSeconds = Math.max(0.5, options.durationMs / 1000);
  for (let i = 0; i < 90; i++) {
    const gs = await client.samples.getSample({ name: apiSample.name });
    if (!isGrpcErrorResult(gs) && gs.sample) {
      const fromProto = durationSecondsFromProtobuf(gs.sample.playDuration as any);
      if (fromProto > 0.1) {
        playSeconds = fromProto;
        break;
      }
      if (gs.sample.mp3Url || gs.sample.wavUrl) {
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }

  const idx = options.layoutIndex ?? 0;
  const posX = 80 + idx * 140;
  const posY = 400;

  await doc.modify((t: any) => {
    const config = t.entities.ofTypes('config').getOne();
    const bpm = config?.fields?.tempoBpm?.value ?? 120;
    const durationTicks = Math.max(1, secondsToTicksAtBpm(playSeconds, bpm));

    const audioDev = t.create('audioDevice', {
      positionX: posX,
      positionY: posY,
      displayName: label,
    });
    if (!audioDev) {
      throw new Error('Failed to create audioDevice');
    }
    connectAudioDeviceToStagebox(t, audioDev);
    if (audioDev.fields?.isActive && !audioDev.fields.isActive.value) {
      t.update(audioDev.fields.isActive, true);
    }

    const sampleEnt = t.create('sample', {
      sampleName: apiSample.name,
      uploadStartTime: BigInt(Math.floor(Date.now() / 1000)),
    });
    if (!sampleEnt) {
      throw new Error('Failed to create sample entity');
    }

    const trackTypes = ['noteTrack', 'audioTrack', 'automationTrack', 'patternTrack'];
    const existingTracks = trackTypes.flatMap((ty) => t.entities.ofTypes(ty).get());
    const maxTrackOrder = existingTracks.reduce((max: number, tr: any) => {
      const order = tr.fields?.orderAmongTracks?.value ?? 0;
      return Math.max(max, order);
    }, -1);

    const audioTrack = t.create('audioTrack', {
      orderAmongTracks: maxTrackOrder + 1,
      player: audioDev.location,
    });
    if (!audioTrack) {
      throw new Error('Failed to create audioTrack');
    }
    if (audioTrack.fields?.isEnabled && !audioTrack.fields.isEnabled.value) {
      t.update(audioTrack.fields.isEnabled, true);
    }

    const playbackAutomationCollection = t.create('automationCollection', {});
    if (!playbackAutomationCollection) {
      throw new Error('Failed to create automationCollection');
    }

    // Playback automation defines sample read position over the region; without events there is no audible output.
    // Same ramp as VideoAudioImporter when no reference curve exists.
    t.create('automationEvent', {
      collection: playbackAutomationCollection.location,
      positionTicks: 0,
      value: 0,
      interpolation: 2,
      slope: 0,
    });
    t.create('automationEvent', {
      collection: playbackAutomationCollection.location,
      positionTicks: durationTicks,
      value: 1,
      interpolation: 2,
      slope: 0,
    });

    const region = t.create('audioRegion', {
      track: audioTrack.location,
      playbackAutomationCollection: playbackAutomationCollection.location,
      sample: sampleEnt.location,
      gain: 1,
      timestretchMode: 2,
      fadeInDurationTicks: 10,
      fadeOutDurationTicks: 10,
      region: {
        positionTicks: 0,
        durationTicks,
        loopDurationTicks: durationTicks,
        collectionOffsetTicks: 0,
        loopOffsetTicks: 0,
        displayName: label.slice(0, 500),
      },
    });
    if (!region) {
      throw new Error('Failed to create audioRegion');
    }
  });
}
