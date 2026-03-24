# Mixing & FX
ENTITY FIELDS REFERENCE (use these EXACT field names with `update-entity-value`):
- heisenberg:
  gain [0..1] (volume, default 0.708)
  glideMs [0..5000] (portamento, default 0)
  tuneSemitones [-12..12] (global tuning, default 0)
  playModeIndex [1..3] (1=Mono, 2=Legato, 3=Poly, default 3)
  unisonoCount [1..4] (voices, default 1)
  unisonoDetuneSemitones [0..1] (detune, default 0.001)
  unisonoStereoSpreadFactor [-1..1] (spread, default 0.5)
  velocityFactor [0..1] (velocity sens, default 1)
  operatorDetuneModeIndex [1..2] (detune mode, default 1)
  isActive (bool, default true)

- bassline:
  cutoffFrequencyHz [220..12000] (filter cutoff, default 220)
  filterDecay [0..1] (filter env decay, default 0)
  filterEnvelopeModulationDepth [0..1] (filter env depth, default 0.1)
  filterResonance [0..1] (resonance, default 1)
  accent [0..1] (accent strength, default 1)
  gain [0..1] (volume, default 0.708)
  tuneSemitones [-12..12] (tuning, default 0)
  waveformIndex [1..2] (1=sawtooth, 2=square, default 1)
  patternIndex [0..27] (active pattern, default 0)
  isActive (bool, default true)

- machiniste:
  globalModulationDepth [-1..1] (mod depth, default 1)
  mainOutputGain [0..1] (volume, default 0.708)
  patternIndex [0..31] (active pattern, default 0)
  isActive (bool, default true)

- tonematrix:
  patternIndex [0..7] (active pattern, default 0)
  isActive (bool, default true)

- stompboxDelay:
  feedbackFactor [0..1] (feedback amount, default 0.4)
  mix [0..1] (dry/wet mix, default 0.2)
  stepCount [1..7] (delay taps, default 3)
  stepLengthIndex [1..3] (1=1/16, 2=1/8T, 3=1/8 bars, default 1)
  isActive (bool, default true)

IMPORTANT: Do NOT invent field names (e.g. 'delayTime', 'frequency').
For all the other dozens of available entities (stompboxChorus, graphicalEQ, pulsar, beatbox8, etc.), you MUST use the `inspect-entity` tool to discover the exact field names and their current values before using `update-entity-value` on a newly added device.

MIXING & EFFECT ROUTING WORKFLOW:
To properly apply insert effects to instruments, use this workflow:
1. Add the effect entity using `add-entity` (e.g. `add-entity stompboxCompressor`). CRITICAL: Set `autoConnectToMixer: false` if you intend to insert this effect in a manual chain, so it doesn't spawn an annoying duplicate mixer channel.
2. Use `list-entities` to find the IDs of the effect, the instrument you want to process, and the mixer channels (`mixerChannel`, `mixerMaster`, etc.).
3. Use `inspect-entity` on the instrument and the effect to find their exact socket names (usually `audioOutput` and `audioInput`).
4. Route the instrument's output to the effect's input using `connect-entities`.
5. Route the effect's output to a mixer channel using `connect-entities` (or if you just want it parallel on its own, let `autoConnectToMixer: true` handle it originally).
You can also tweak the mix by inspecting the `mixerChannel` and tuning faders using `update-entity-value`.

MIXING RECIPES & ADVICE:
When asked how to mix specific instruments, use these Audiotool guidelines:
* Vocals: Compressor (Med threshold -18dB, 4:1 ratio, fast attack 10ms, med release 100ms). EQ (Low-cut at ~80Hz, dip at 300Hz, boost at 2.5-3kHz for presence, slight target above 8kHz for air). FX (Room/Plate reverb).
* Kick Drum: EQ (Boost at 60-80Hz, cut around 400Hz, click around 2-3kHz). Compressor (Slow attack 20-30ms, fast release 50ms).
* Snare: EQ (Boost at 200Hz and 5kHz for snap). FX (Short reverb or plate).
* Hi-Hats: EQ (High-pass at 200Hz, boost at 8-10kHz).
* Bass: Compressor (High ratio 6:1, threshold -20dB). EQ (Low shelf at 80Hz, cut at 300Hz). Consider sidechaining to the kick.
* Synths/Keys: EQ (Low-cut at 100Hz, boost at 1-2kHz for presence). FX (Delay or chorus for width).
* Guitars: EQ (High-pass at 100Hz, cut 300Hz if muddy, boost 3-5kHz).

GROUPS & FX SENDS:
- Use Groups (Cmd/Ctrl+G) to process multiple tracks together (e.g., bus compression for all drums, shared reverb for vocals).
- Every mixer channel has a built-in Reverb and Delay send. Use FX sends to blend effects with the original dry signal to create space and depth without muddying the mix. Delay is great for rhythmic width; Reverb for presence and size.
