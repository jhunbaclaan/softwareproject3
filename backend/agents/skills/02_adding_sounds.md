# Adding Sounds & MIDI
ENTITY TYPES:
When the user asks for a synth or sound 'like X' (an artist, genre, or adjective), use `recommend-entity-for-style` to find the most appropriate entity type, or use these direct mappings:
- Synths: `heisenberg` (default poly), `bassline` (mono/acid), `pulsar` (FM), `pulverisateur` (modular), `kobolt` (virtual analog), `space` (sampler).
- Orchestral / GM instruments: `gakki` sampler — has 128 General MIDI instruments (violin, french-horn, marimba, pan-flute, ...) and 8 drum kits (standard-kit, jazz-kit, ...).
- Drums: `machiniste`, `beatbox8` (808), `beatbox9` (909).
- Logic/Sequencers: `tonematrix` (step), `matrixArpeggiator`.
- Effects: `stompboxDelay`, `stompboxChorus`, `stompboxReverb`, `graphicalEQ`, `stompboxCompressor`, etc.

BATCH ADDING:
When adding multiple entities at once, use `add-entity` with the `entities` array parameter to create them all in a single call instead of calling `add-entity` multiple times.

ORCHESTRAL / GM INSTRUMENTS (`add-entity`):
The user's request can name a GM instrument directly. Pass it as `entityType` — the server routes it to a `gakki` device and auto-applies the matching GM preset. Examples: `entityType: "violin"`, `entityType: "french horn"`, `entityType: "marimba"`, `entityType: "pan flute"`. For drum kits, pass `drumKit: "jazz-kit"` (or `"room-kit"`, `"power-kit"`, `"electronic-kit"`, `"analog-kit"`, `"brush-kit"`, `"orchestra-kit"`, `"standard-kit"`). If you need to be explicit, pass `entityType: "gakki"` plus `instrument: "violin"` (or `drumKit: "jazz-kit"`). If you pass bare `entityType: "gakki"` with no hint, the device loads the default acoustic-piano preset — avoid this unless the user really wants a piano.

ABC NOTATION:
When the user provides music in ABC notation (e.g. `X:1, K:C, L:1/4, CDEF GABc|`), call `add-abc-track` with the `abcNotation` parameter containing the full ABC string (without markdown). Extract the raw ABC from code blocks or plain text.
For orchestral / GM sounds (violin, french horn, trumpet, marimba, strings, etc.), set `instrument` to the specific instrument name — the server resolves it to the canonical GM slug and loads the matching gakki preset atomically with device creation. Do NOT pass bare `instrument: "gakki"` (that falls back to the default grand-piano preset). If you need to use `instrument: "strings"` / `"brass"` / `"horn"` etc. for some reason, additionally set `orchestralVoice` to the user's specific instrument.
For synth/bass/drums use `heisenberg`, `bassline`, `pulsar`, `machiniste`, `beatbox8`, etc. Default instrument is `heisenberg`.
When adding multiple ABC tracks at once, use `add-abc-track` with the `tracks` array parameter to create them all in a single call.

APPLYING PRESETS TO EXISTING DEVICES (`apply-preset`):
Use `apply-preset` when the user asks to change the sound of an existing device. Provide exactly one of: `presetID` (from `list-presets`), `instrumentSlug` (GM instrument slug for gakki — `"violin"`, `"marimba"`, ...), or `drumKitSlug` (GM drum-kit slug for gakki — `"jazz-kit"`, ...).

SYNTHESIZER SOUND DESIGN THEORY:
When users ask about making custom sounds, explain these basics:
- Oscillators: Generate raw waveforms (Sine = pure, Triangle = mellow, Sawtooth = bright/rich, Square = hollow).
- Filters: Shape sound by removing frequencies (Low-pass removes highs to make it darker, High-pass removes lows, Band-pass keeps middle).
- Envelopes (ADSR): Control how sounds change over time (Attack, Decay, Sustain, Release).
- Modulation: Adds movement (LFO for rhythmic pulsing, Envelopes for time-based sweeps). "Oscillator creates sound -> Filter shapes it -> Envelope controls timing -> Modulation adds movement."
