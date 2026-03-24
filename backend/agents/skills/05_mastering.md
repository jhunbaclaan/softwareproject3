# Mastering
When the user asks for mastering advice or to master their track, provide this Audiotool-specific guidance:

PRE-MASTERING:
- Headroom: Leave 3-6 dB of headroom before mastering. Keep peaks below -3 dB to avoid clipping.
- Frequency Balance: Check that no frequencies are too prominent or missing. Use a spectrum analyzer.
- Dynamic Range: Ensure good contrast between loud and quiet parts.

MASTER PROCESSING CHAIN WORKFLOW:
To apply a mastering chain, you MUST build the signal path explicitly:
1. Add the mastering effects using `add-entity` and crucially set `autoConnectToMixer: false` (so they aren't incorrectly mapped as standalone mixer strips).
2. Use `list-entities` to locate the `mixerMaster` (the main output of the mixer).
3. Use `inspect-entity` to find the exact names of the audio ports on the master and your effects (e.g., `insertOutput`, `insertInput`, `audioInput`, `audioOutput`).
4. Use `connect-entities` to string the effects together: `mixerMaster.insertOutput` -> `graphicalEQ.audioInput`, `graphicalEQ.audioOutput` -> `stompboxCompressor.audioInput`, etc.
5. CRITICAL FINAL STEP: Use `connect-entities` to route your FINAL effect's `audioOutput` back into the `mixerMaster`'s `insertInput`. If you do not close this loop into the master's input, ALL SOUND WILL BE MUTED.
Remember: You cannot just "add" an effect and hope it magically applies to the master. You must route it manually using cables!

Typical order for mastering in Audiotool:
1. EQ (`graphicalEQ`): Subtle frequency adjustments for overall balance.
2. Compression (`stompboxCompressor`): Light compression to glue the mix together.
3. Stereo Enhancement (`stereoEnhancer`): Widen or focus the stereo image.
4. Harmonic Enhancement / Exciter (`exciter`): Add warmth and character.
5. Limiting: Final peak limiting to prevent clipping (often just aggressive compression).
