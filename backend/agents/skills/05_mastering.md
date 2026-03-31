# Mastering
When the user asks for mastering advice or to master their track, provide this Audiotool-specific guidance:

PRE-MASTERING:
- Headroom: Leave 3-6 dB of headroom before mastering. Keep peaks below -3 dB to avoid clipping.
- Frequency Balance: Check that no frequencies are too prominent or missing. Use a spectrum analyzer.
- Dynamic Range: Ensure good contrast between loud and quiet parts.

MASTER PROCESSING CHAIN WORKFLOW:
To apply a true "Mastering" chain across multiple instruments, you MUST use the Desktop Mastering workflow. Do NOT attempt to wire effects to the `mixerMaster` device using its `insertOutput`/`insertInput` ports. In the Audiotool web UI, creating `desktopAudioCable`s connecting to the internal Master Mixer produces invisible invalid cables that crash the Web Audio engine!

Furthermore, Audiotool DOES NOT allow you to plug multiple cables into the same input socket (e.g. you cannot plug multiple instruments directly into `graphicalEQ.audioInput`). Doing so will trigger a strict backend validation error (`multiple pointers to field accepting at most one`).

To master all tracks instantly and correctly:
1. **CRITICAL REQUIREMENT:** You MUST set `autoConnectToMixer: false` when using `add-abc-track` or `add-entity` for any tracks you plan to master. If you forget this, the instrument naturally connects to the mixer. Running a mastering chain on it later creates an illegal "Y-split" cable that will crash the application GUI! Avoid this by explicitly passing `autoConnectToMixer: false`.
2. Add your merging device (e.g. `audioMerger` or `minimixer`), your entire chain of mastering effects, and ONE final `mixerChannel`. **You MUST use the `batch-add-entities` tool** for this to spawn them all instantly in a single turn instead of calling `add-entity` repeatedly. Set `autoConnectToMixer: false` for all effects.
3. Identify the distinct input sockets of your combining device from the results of `batch-add-entities` (they usually have incremental names like `audioInputA`, `audioInputB` etc).
4. Identify the `playerEntityId` returned by `add-abc-track`. Do NOT use the `noteTrackId` for audio connections!
5. Using a SINGLE call to `batch-connect-entities`, route your instruments into distinct inputs on the merger, then route the merger out to the effects, and finally to the mixer channel!
   Example valid `batch-connect-entities` array:
   - `instrument1.audioOutput` -> `audioMerger.audioInputA` (Use distinct inputs!)
   - `instrument2.audioOutput` -> `audioMerger.audioInputB`
   - `audioMerger.audioOutput` -> `graphicalEQ.audioInput`
   - `graphicalEQ.audioOutput` -> `stompboxCompressor.audioInput`
   - `stompboxCompressor.audioOutput` -> `NEW_mixerChannel.audioInput`

Wait, what if the instruments were ALREADY connected to their own mixer channels before you were asked to master?
**CRITICAL: You MUST use the `disconnect-entities` tool to break their original cables.** Identify the `mixerChannel` they originally connect to, then disconnect it before trying to route the instrument into the mastering chain. Do NOT attempt to dynamically split an output socket!

When tweaking effect parameters on the mastering chain, ALWAYS use the `update-entity-values` tool to batch changes into a single turn instead of making sequential single-parameter updates.

Typical order for mastering in Audiotool:
1. EQ (`graphicalEQ`): Subtle frequency adjustments for overall balance.
2. Compression (`stompboxCompressor`): Light compression to glue the mix together.
3. Stereo Enhancement (`stereoEnhancer`): Widen or focus the stereo image.
4. Harmonic Enhancement / Exciter (`exciter`): Add warmth and character.
5. Limiting: Final peak limiting to prevent clipping (often just aggressive compression).
