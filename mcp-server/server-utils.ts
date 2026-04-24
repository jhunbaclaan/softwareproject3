/**
 * Extracted utility functions and constants from server.ts for testability.
 * All pure functions and constant data structures live here.
 */

import abcjs from "abcjs";
import type { GmInstrumentSlug, GmDrumSlug } from "@audiotool/nexus/api";

/**
 * Canonical 0-indexed GM program numbers by kebab-case slug.
 *
 * These mirror `@audiotool/nexus`'s internal `gmInstrumentProgramBySlug` /
 * `gmDrumProgramBySlug` tables. The SDK currently exports the *types*
 * (GmInstrumentSlug, GmDrumSlug) publicly but not the underlying data, so we
 * ship it here to validate user input against the same canonical list.
 *
 * The GM 1.0 assignments are pinned — these tables shouldn't need to change
 * between SDK releases. The `satisfies Record<..., number>` clause gives us
 * a compile-time error if a slug we ship doesn't match the SDK type.
 */
const GM_INSTRUMENT_PROGRAM_BY_SLUG = {
  "acoustic-piano": 0, "bright-grand-2": 1, "piano-2": 2, "honky-tonk-piano": 3,
  "electronic-piano-1": 4, "electronic-piano-2": 5, harpsichord: 6, clavinet: 7,
  celesta: 8, glockenspiel: 9, "music-box": 10, vibraphone: 11,
  marimba: 12, xylophone: 13, "tubular-bells": 14, dulcimer: 15,
  "jazz-organ": 16, "hammond-organ": 17, "rock-organ": 18, "church-organ": 19,
  "reed-organ": 20, accordion: 21, harmonica: 22, bandoneon: 23,
  "nylon-guitar": 24, "dark-steel-guitar": 25, "jazz-guitar": 26, "clean-guitar": 27,
  "muted-guitar": 28, "overdriven-guitar": 29, "distortion-guitar": 30, "guitar-harmonics": 31,
  "acoustic-bass": 32, "fingered-bass": 33, "picked-bass": 34, "fretless-bass": 35,
  "slap-bass-1": 36, "slap-bass-2": 37, "synth-bass-1": 38, "synth-bass-2": 39,
  violin: 40, viola: 41, cello: 42, contrabass: 43,
  "tremolo-strings": 44, "pizzicato-strings": 45, harp: 46, timpani: 47,
  "string-section": 48, "string-ensemble": 49, "synth-strings-1": 50, "synth-strings-2": 51,
  "choir-aahs": 52, "choir-oohs": 53, "synth-voice": 54, "orchestra-hit": 55,
  trumpet: 56, trombone: 57, tuba: 58, "muted-trumpet": 59,
  "french-horn": 60, "brass-section": 61, "synth-brass-1": 62, "synth-brass-2": 63,
  "soprano-sax": 64, "alto-sax": 65, "tenor-sax": 66, "baritone-sax": 67,
  oboe: 68, "english-horn": 69, bassoon: 70, clarinet: 71,
  piccolo: 72, flute: 73, recorder: 74, "pan-flute": 75,
  "blown-bottle": 76, shakuhachi: 77, whistle: 78, ocarina: 79,
  "square-lead": 80, "saw-lead": 81, "calliope-lead": 82, "chiffer-lead": 83,
  charang: 84, "solo-voice": 85, "fifth-sawtooth": 86, "bass-lead": 87,
  "fantasia-pad": 88, "warm-pad": 89, polysynth: 90, "space-voice": 91,
  "bowed-glass": 92, metal: 93, halo: 94, sweep: 95,
  rain: 96, soundtrack: 97, crystal: 98, atmosphere: 99,
  brightness: 100, goblins: 101, "echo-drops": 102, "sci-fi": 103,
  sitar: 104, banjo: 105, shamisen: 106, koto: 107,
  kalimba: 108, bagpipe: 109, fiddle: 110, shanai: 111,
  "tinkle-bells": 112, agogo: 113, "steel-drums": 114, woodblock: 115,
  "taiko-drum": 116, "melodic-drum": 117, "synth-tom": 118, "reverse-cymbal": 119,
  "guitar-fret-noise": 120, "breath-noise": 121, seashore: 122, "bird-tweet": 123,
  "telephone-ring": 124, helicopter: 125, applause: 126, gunshot: 127,
} as const satisfies Record<GmInstrumentSlug, number>;

const GM_DRUM_PROGRAM_BY_SLUG = {
  "standard-kit": 0,
  "room-kit": 8,
  "power-kit": 16,
  "electronic-kit": 24,
  "analog-kit": 25,
  "jazz-kit": 32,
  "brush-kit": 40,
  "orchestra-kit": 48,
} as const satisfies Record<GmDrumSlug, number>;

export const VALID_ENTITY_TYPES = [
  "audioDevice", "audioMerger", "audioSplitter", "autoFilter", "bandSplitter",
  "bassline", "beatbox8", "beatbox9", "centroid", "crossfader", "curve", "exciter",
  "gakki", "graphicalEQ", "gravity", "heisenberg", "helmholtz", "kobolt", "machiniste",
  "matrixArpeggiator", "minimixer", "noteSplitter", "panorama", "pulsar", "pulverisateur",
  "quantum", "quasar", "rasselbock", "ringModulator", "space", "stereoEnhancer",
  "stompboxChorus", "stompboxCompressor", "stompboxCrusher", "stompboxDelay",
  "stompboxFlanger", "stompboxGate", "stompboxParametricEqualizer", "stompboxPhaser",
  "stompboxPitchDelay", "stompboxReverb", "stompboxSlope", "stompboxStereoDetune",
  "stompboxTube", "tinyGain", "tonematrix", "waveshaper", "notetrack",
  "mixerChannel", "mixerMaster", "mixerGroup", "mixerAux", "mixerReverbAux", "mixerDelayAux"
] as const;

export const ENTITY_TYPE_ALIASES: Record<string, string> = {
  machinedrum: "machiniste",
  "drum machine": "machiniste",
  drummachine: "machiniste",
  "808": "beatbox8",
  "909": "beatbox9",
  chorus: "stompboxChorus",
  compressor: "stompboxCompressor",
  crusher: "stompboxCrusher",
  delay: "stompboxDelay",
  flanger: "stompboxFlanger",
  gate: "stompboxGate",
  eq: "graphicalEQ",
  phaser: "stompboxPhaser",
  "pitch delay": "stompboxPitchDelay",
  reverb: "stompboxReverb",
  slope: "stompboxSlope",
  detune: "stompboxStereoDetune",
  tube: "stompboxTube",
  sampler: "space",
  modular: "pulverisateur",
  "fm synth": "pulsar",
  // GM instrument names → gakki sampler. The specific preset is picked later
  // via `client.presets.getInstrument(slug)`; see resolveGmInstrumentSlug.
  violin: "gakki",
  viola: "gakki",
  cello: "gakki",
  contrabass: "gakki",
  "double bass": "gakki",
  "upright bass": "gakki",
  "acoustic bass": "gakki",
  trumpet: "gakki",
  trombone: "gakki",
  tuba: "gakki",
  "french horn": "gakki",
  horn: "gakki",
  "english horn": "gakki",
  "muted trumpet": "gakki",
  flute: "gakki",
  piccolo: "gakki",
  oboe: "gakki",
  clarinet: "gakki",
  bassoon: "gakki",
  "pan flute": "gakki",
  recorder: "gakki",
  shakuhachi: "gakki",
  ocarina: "gakki",
  whistle: "gakki",
  sax: "gakki",
  saxophone: "gakki",
  "soprano sax": "gakki",
  "alto sax": "gakki",
  "tenor sax": "gakki",
  "baritone sax": "gakki",
  strings: "gakki",
  "string section": "gakki",
  "string ensemble": "gakki",
  "pizzicato strings": "gakki",
  "tremolo strings": "gakki",
  brass: "gakki",
  "brass section": "gakki",
  piano: "gakki",
  "grand piano": "gakki",
  "acoustic piano": "gakki",
  "electric piano": "gakki",
  rhodes: "gakki",
  wurlitzer: "gakki",
  organ: "gakki",
  "church organ": "gakki",
  "rock organ": "gakki",
  "jazz organ": "gakki",
  "hammond organ": "gakki",
  harpsichord: "gakki",
  clavinet: "gakki",
  celesta: "gakki",
  glockenspiel: "gakki",
  marimba: "gakki",
  vibraphone: "gakki",
  xylophone: "gakki",
  "tubular bells": "gakki",
  "music box": "gakki",
  dulcimer: "gakki",
  harp: "gakki",
  timpani: "gakki",
  choir: "gakki",
  sitar: "gakki",
  banjo: "gakki",
  shamisen: "gakki",
  koto: "gakki",
  kalimba: "gakki",
  bagpipe: "gakki",
  bagpipes: "gakki",
  fiddle: "gakki",
  accordion: "gakki",
  harmonica: "gakki",
  "steel drums": "gakki",
  "taiko drum": "gakki",
  "acoustic guitar": "gakki",
  "electric guitar": "gakki",
  "nylon guitar": "gakki",
  "jazz guitar": "gakki",
};

/** Instruments that can play note tracks (NoteTrackPlayer). Used for add-abc-track. */
export const NOTE_TRACK_INSTRUMENTS = [
  "heisenberg", "bassline", "space", "gakki", "pulverisateur",
  "tonematrix", "machiniste", "matrixArpeggiator", "pulsar",
  "kobolt", "beatbox8", "beatbox9", "centroid", "rasselbock"
] as const;

export const INSTRUMENT_ALIASES: Record<string, string> = {
  synth: "heisenberg",
  "poly synth": "heisenberg",
  pad: "heisenberg",
  lead: "heisenberg",
  bass: "bassline",
  "bass synth": "bassline",
  acid: "bassline",
  sampler: "space",
  rompler: "space",
  strings: "gakki",
  "string synth": "gakki",
  drums: "machiniste",
  "drum machine": "machiniste",
  sequencer: "tonematrix",
  "step sequencer": "tonematrix",
  arpeggiator: "matrixArpeggiator",
  matrix: "matrixArpeggiator",
  // Gakki has French horn and other orchestral sounds (GM-slug preset picked later)
  "french horn": "gakki",
  horn: "gakki",
  trumpet: "gakki",
  trombone: "gakki",
  tuba: "gakki",
  brass: "gakki",
  woodwind: "gakki",
  flute: "gakki",
  oboe: "gakki",
  clarinet: "gakki",
  bassoon: "gakki",
  violin: "gakki",
  viola: "gakki",
  cello: "gakki",
  piano: "gakki",
  "808": "beatbox8",
  "909": "beatbox9",
  modular: "pulverisateur",
  fm: "pulsar"
};

/** Audiotool ticks: 1 whole note = 15360, 1 quarter = 3840 */
export const TICKS_WHOLE = 15360;
export const TICKS_QUARTER = 3840;

/**
 * LLMs often flatten ABC headers onto one line with spaces (e.g. `X:1 T:Title M:4/4`)
 * instead of newline-separated lines. abcjs may then yield no notes.
 * Inserts newlines before standard single-letter ABC information fields.
 */
export function normalizeAbcNotation(input: string): string {
  let s = input.trim();
  if (!s) return s;
  // Single-line headers: "X:1 T:Title M:4/4 K:G" -> one field per line
  s = s.replace(/\s+([A-Z]:)/g, "\n$1");
  // Body often stuck on same line as K: "K:G |:CDEF|..." — abcjs needs the tune body on a new line
  s = s.replace(/(K:[^\n]*?)\s+(\|:)/g, "$1\n$2");
  // Second repeat / section: "| |:g2" -> newline before the next |:
  s = s.replace(/\|\s+(\|:)/g, "|\n$1");
  return s;
}

/**
 * Parse ABC notation and extract notes using abcjs.
 * Returns { pitch, positionTicks, durationTicks, velocity }.
 */
export function parseAbcToNotes(abcString: string): Array<{ pitch: number; positionTicks: number; durationTicks: number; velocity: number }> {
  const notes: Array<{ pitch: number; positionTicks: number; durationTicks: number; velocity: number }> = [];
  try {
    const normalized = normalizeAbcNotation(abcString);
    const tuneObjs = abcjs.parseOnly(normalized.trim());
    if (!tuneObjs || tuneObjs.length < 1) {
      throw new Error("No tune found in ABC notation");
    }
    const tuneObj = tuneObjs[0] as { setUpAudio?: (opts?: object) => { tracks?: Array<Array<{ cmd?: string; pitch?: number; start?: number; duration?: number; volume?: number }>> } };
    const audio = tuneObj?.setUpAudio?.({});
    if (!audio?.tracks) {
      throw new Error("Could not extract sequence from ABC");
    }
    for (const track of audio.tracks) {
      if (!Array.isArray(track)) continue;
      for (const ev of track) {
        if (ev.cmd === "note" && ev.pitch != null) {
          const start = ev.start ?? 0;
          const duration = ev.duration ?? 0.25;
          const positionTicks = Math.round(start * TICKS_WHOLE);
          const durationTicks = Math.max(TICKS_QUARTER / 4, Math.round(duration * TICKS_WHOLE));
          const velocity = ev.volume != null ? Math.min(1, Math.max(0, ev.volume / 127)) : 0.7;
          notes.push({
            pitch: Math.max(0, Math.min(127, ev.pitch)),
            positionTicks,
            durationTicks,
            velocity,
          });
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse ABC notation: ${msg}`);
  }
  return notes.sort((a, b) => a.positionTicks - b.positionTicks);
}

export function levenshtein(a: string, b: string): number {
  const m = a.length,
    n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0),
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Resolve a user-supplied entity type to a valid one via:
 * 1. exact match, 2. case-insensitive match, 3. Levenshtein fuzzy match (max distance 3).
 */
export function resolveEntityType(input: string): string | null {
  const trimmed = input.trim();
  if (VALID_ENTITY_TYPES.includes(trimmed as any)) return trimmed;

  const lower = trimmed.toLowerCase();

  if (ENTITY_TYPE_ALIASES[lower]) return ENTITY_TYPE_ALIASES[lower];

  const ciMatch = VALID_ENTITY_TYPES.find((t) => t.toLowerCase() === lower);
  if (ciMatch) return ciMatch;

  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of VALID_ENTITY_TYPES) {
    const d = levenshtein(lower, t.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 3 ? best : null;
}

/**
 * Resolve user-supplied instrument name to a valid NoteTrackPlayer type.
 */
export function resolveInstrumentType(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  if (NOTE_TRACK_INSTRUMENTS.includes(trimmed as any)) return trimmed;
  if (INSTRUMENT_ALIASES[trimmed]) return INSTRUMENT_ALIASES[trimmed];
  const ciMatch = NOTE_TRACK_INSTRUMENTS.find((t) => t.toLowerCase() === trimmed);
  if (ciMatch) return ciMatch;
  let best: string | null = null;
  let bestDist = Infinity;
  for (const t of NOTE_TRACK_INSTRUMENTS) {
    const d = levenshtein(trimmed, t.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return bestDist <= 3 ? best : null;
}

/**
 * Canonical GM instrument slugs accepted by `client.presets.getInstrument()`.
 * Backed by the pinned-GM-1.0 table above.
 */
export const GM_INSTRUMENT_SLUGS: ReadonlySet<GmInstrumentSlug> = new Set(
  Object.keys(GM_INSTRUMENT_PROGRAM_BY_SLUG) as GmInstrumentSlug[],
);

/** Canonical GM drum-kit slugs accepted by `client.presets.getDrums()`. */
export const GM_DRUM_SLUGS: ReadonlySet<GmDrumSlug> = new Set(
  Object.keys(GM_DRUM_PROGRAM_BY_SLUG) as GmDrumSlug[],
);

export function isGmInstrumentSlug(s: string): s is GmInstrumentSlug {
  return GM_INSTRUMENT_SLUGS.has(s as GmInstrumentSlug);
}

export function isGmDrumSlug(s: string): s is GmDrumSlug {
  return GM_DRUM_SLUGS.has(s as GmDrumSlug);
}

function normalizeSlugInput(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[()]/g, "");
}

/**
 * Friendly-name → canonical SDK slug overrides, for words the user commonly
 * says that don't match a slug exactly.
 *
 * Keys are the *normalized* form of the input: lowercased, trimmed,
 * spaces/underscores collapsed to hyphens.
 */
export const GM_INSTRUMENT_SLUG_SYNONYMS: Record<string, GmInstrumentSlug> = {
  // Piano family
  piano: "acoustic-piano",
  "grand-piano": "acoustic-piano",
  "acoustic-grand-piano": "acoustic-piano",
  "acoustic-grand": "acoustic-piano",
  "electric-piano": "electronic-piano-1",
  rhodes: "electronic-piano-1",
  wurlitzer: "electronic-piano-2",
  // String family
  strings: "string-section",
  "string-ensemble-1": "string-section",
  "string-ensemble-2": "string-ensemble",
  orchestral: "string-section",
  symphonic: "string-section",
  "double-bass": "contrabass",
  doublebass: "contrabass",
  "upright-bass": "acoustic-bass",
  // Brass
  brass: "brass-section",
  horn: "french-horn",
  sax: "alto-sax",
  saxophone: "alto-sax",
  // Guitars
  guitar: "clean-guitar",
  "acoustic-guitar": "nylon-guitar",
  "electric-guitar": "clean-guitar",
  "bass-guitar": "fingered-bass",
  bass: "fingered-bass",
  "steel-guitar": "dark-steel-guitar",
  // Organs & misc
  organ: "church-organ",
  bells: "tubular-bells",
  "tubular-bell": "tubular-bells",
  "pan-pipes": "pan-flute",
  bagpipes: "bagpipe",
  choir: "choir-aahs",
};

/** Friendly-name → canonical GM drum-kit slug overrides. */
export const GM_DRUM_SLUG_SYNONYMS: Record<string, GmDrumSlug> = {
  drums: "standard-kit",
  kit: "standard-kit",
  standard: "standard-kit",
  room: "room-kit",
  power: "power-kit",
  electronic: "electronic-kit",
  analog: "analog-kit",
  jazz: "jazz-kit",
  brush: "brush-kit",
  brushes: "brush-kit",
  orchestra: "orchestra-kit",
  orchestral: "orchestra-kit",
};

/**
 * Resolve a user-supplied instrument name to a canonical GM slug accepted by
 * `client.presets.getInstrument()`. Returns undefined if nothing matches.
 */
export function resolveGmInstrumentSlug(
  input: string,
): GmInstrumentSlug | undefined {
  const key = normalizeSlugInput(input);
  if (!key) return undefined;
  if (isGmInstrumentSlug(key)) return key;
  return GM_INSTRUMENT_SLUG_SYNONYMS[key];
}

/**
 * Resolve a user-supplied drum-kit name to a canonical GM drum slug accepted
 * by `client.presets.getDrums()`. Returns undefined if nothing matches.
 */
export function resolveGmDrumSlug(input: string): GmDrumSlug | undefined {
  const key = normalizeSlugInput(input);
  if (!key) return undefined;
  if (isGmDrumSlug(key)) return key;
  return GM_DRUM_SLUG_SYNONYMS[key];
}

/**
 * Match freeform user or ABC text against common phrasings.
 * Ordered so multi-word phrases match before single words.
 */
export const GM_INSTRUMENT_TEXT_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  slug: GmInstrumentSlug;
}> = [
  { pattern: /\bfrench\s+horn\b/i, slug: "french-horn" },
  { pattern: /\benglish\s+horn\b/i, slug: "english-horn" },
  { pattern: /\bmuted\s+trumpet\b/i, slug: "muted-trumpet" },
  { pattern: /\bbrass\s+section\b/i, slug: "brass-section" },
  { pattern: /\bstring\s+section\b/i, slug: "string-section" },
  { pattern: /\bstring\s+ensemble\b/i, slug: "string-ensemble" },
  { pattern: /\bpizzicato\s+strings?\b/i, slug: "pizzicato-strings" },
  { pattern: /\btremolo\s+strings?\b/i, slug: "tremolo-strings" },
  { pattern: /\belectric\s+piano\b/i, slug: "electronic-piano-1" },
  { pattern: /\bacoustic\s+piano\b/i, slug: "acoustic-piano" },
  { pattern: /\bgrand\s+piano\b/i, slug: "acoustic-piano" },
  { pattern: /\bhonky[\s-]tonk\b/i, slug: "honky-tonk-piano" },
  { pattern: /\bpan\s+flute\b/i, slug: "pan-flute" },
  { pattern: /\bchurch\s+organ\b/i, slug: "church-organ" },
  { pattern: /\brock\s+organ\b/i, slug: "rock-organ" },
  { pattern: /\btrumpet\b/i, slug: "trumpet" },
  { pattern: /\btrombone\b/i, slug: "trombone" },
  { pattern: /\btuba\b/i, slug: "tuba" },
  { pattern: /\bviolin\b/i, slug: "violin" },
  { pattern: /\bviola\b/i, slug: "viola" },
  { pattern: /\bcello\b/i, slug: "cello" },
  { pattern: /\bcontrabass\b/i, slug: "contrabass" },
  { pattern: /\bdouble\s*bass\b/i, slug: "contrabass" },
  { pattern: /\bharp\b/i, slug: "harp" },
  { pattern: /\bharpsichord\b/i, slug: "harpsichord" },
  { pattern: /\btimpani\b/i, slug: "timpani" },
  { pattern: /\bflute\b/i, slug: "flute" },
  { pattern: /\bpiccolo\b/i, slug: "piccolo" },
  { pattern: /\boboe\b/i, slug: "oboe" },
  { pattern: /\bclarinet\b/i, slug: "clarinet" },
  { pattern: /\bbassoon\b/i, slug: "bassoon" },
  { pattern: /\brecorder\b/i, slug: "recorder" },
  { pattern: /\bshakuhachi\b/i, slug: "shakuhachi" },
  { pattern: /\bocarina\b/i, slug: "ocarina" },
  { pattern: /\bwhistle\b/i, slug: "whistle" },
  { pattern: /\bsax\w*\b/i, slug: "alto-sax" },
  { pattern: /\bhorn\b/i, slug: "french-horn" },
  { pattern: /\bbrass\b/i, slug: "brass-section" },
  { pattern: /\bmarimba\b/i, slug: "marimba" },
  { pattern: /\bvibraphone\b/i, slug: "vibraphone" },
  { pattern: /\bxylophone\b/i, slug: "xylophone" },
  { pattern: /\bglockenspiel\b/i, slug: "glockenspiel" },
  { pattern: /\bsitar\b/i, slug: "sitar" },
  { pattern: /\bbanjo\b/i, slug: "banjo" },
  { pattern: /\bkoto\b/i, slug: "koto" },
  { pattern: /\bkalimba\b/i, slug: "kalimba" },
  { pattern: /\bbagpipes?\b/i, slug: "bagpipe" },
  { pattern: /\bfiddle\b/i, slug: "fiddle" },
  { pattern: /\baccordion\b/i, slug: "accordion" },
  { pattern: /\bharmonica\b/i, slug: "harmonica" },
  { pattern: /\bstrings\b/i, slug: "string-section" },
  { pattern: /\bpiano\b/i, slug: "acoustic-piano" },
  { pattern: /\borgan\b/i, slug: "church-organ" },
  { pattern: /\bchoir\b/i, slug: "choir-aahs" },
];

/**
 * Resolve a GM instrument slug from a combination of hint fields:
 *   1. `orchestralVoice` (most specific),
 *   2. `instrument`,
 *   3. `abcNotation` (full-text pattern match).
 * Returns undefined if no match is found — callers should then fall back to
 * the `gakki` default preset.
 */
export function resolveGmInstrumentSlugFromHints(args: {
  instrument?: string;
  orchestralVoice?: string;
  abcNotation?: string;
}): GmInstrumentSlug | undefined {
  for (const s of [args.orchestralVoice, args.instrument]) {
    if (!s?.trim()) continue;
    const slug = resolveGmInstrumentSlug(s);
    if (slug) return slug;
  }
  const haystack = [
    args.abcNotation ?? "",
    args.orchestralVoice ?? "",
    args.instrument ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  if (!haystack) return undefined;
  for (const { pattern, slug } of GM_INSTRUMENT_TEXT_PATTERNS) {
    if (pattern.test(haystack)) return slug;
  }
  return undefined;
}

/**
 * Extract the referenced entity ID from a nexus reference field.
 * Reference fields are PrimitiveField<NexusLocation> where .value is
 * a NexusLocation with an entityId property.
 */
export function refId(field: any): string | null {
  if (!field) return null;
  const val = field.value;
  if (val && typeof val === "object" && typeof val.entityId === "string") return val.entityId;
  if (typeof val === "string") return val;
  return null;
}

/** Entity types that produce audio and their output field name. */
export const AUDIO_OUTPUT_FIELD: Record<string, string> = {
  audioDevice: "audioOutput",
  heisenberg: "audioOutput",
  bassline: "audioOutput",
  machiniste: "mainOutput",
  tonematrix: "audioOutput",
  stompboxDelay: "audioOutput",
  space: "audioOutput",
  gakki: "audioOutput",
  pulverisateur: "audioOutput",
  matrixArpeggiator: "audioOutput",
  audioMerger: "audioOutput",
  audioSplitter: "audioOutput1",
  autoFilter: "audioOutput",
  bandSplitter: "highOutput",
  beatbox8: "mainOutput",
  beatbox9: "mainOutput",
  centroid: "audioOutput",
  crossfader: "audioOutput",
  curve: "audioOutput",
  exciter: "audioOutput",
  graphicalEQ: "audioOutput",
  gravity: "audioOutput",
  helmholtz: "audioOutput",
  kobolt: "audioOutput",
  minimixer: "mainOutput",
  panorama: "audioOutput",
  pulsar: "audioOutput",
  quantum: "audioOutput",
  quasar: "audioOutput",
  rasselbock: "audioOutput",
  ringModulator: "audioOutput",
  stereoEnhancer: "audioOutput",
  stompboxChorus: "audioOutput",
  stompboxCompressor: "audioOutput",
  stompboxCrusher: "audioOutput",
  stompboxFlanger: "audioOutput",
  stompboxGate: "audioOutput",
  stompboxParametricEqualizer: "audioOutput",
  stompboxPhaser: "audioOutput",
  stompboxPitchDelay: "audioOutput",
  stompboxReverb: "audioOutput",
  stompboxSlope: "audioOutput",
  stompboxStereoDetune: "audioOutput",
  stompboxTube: "audioOutput",
  tinyGain: "audioOutput",
  waveshaper: "audioOutput"
};

/**
 * Connect an audio device to the stagebox (mixer).
 */
export function connectDeviceToStagebox(t: any, device: any, entityType: string): void {
  const outputFieldName = AUDIO_OUTPUT_FIELD[entityType];
  if (!outputFieldName) return;

  const outputField = (device.fields as any)[outputFieldName];
  if (!outputField?.location) return;

  const stripTypes = ["mixerChannel", "mixerGroup", "mixerAux", "mixerReverbAux", "mixerDelayAux"];
  const existingStrips = stripTypes.flatMap((type) =>
    t.entities.ofTypes(type as any).get()
  );
  const maxOrder = existingStrips.reduce((max: number, s: any) => {
    const dp = (s.fields as any).displayParameters;
    const order = dp?.fields?.orderAmongStrips?.value ?? 0;
    return Math.max(max, order);
  }, -1);
  const nextOrder = maxOrder + 1;

  const deviceDisplayName = (device.fields as any).displayName?.value ?? "";
  const channelLabel = deviceDisplayName || `${entityType} ${nextOrder}`;

  const mixerChannel = t.create("mixerChannel" as any, {});
  if (!mixerChannel) return;

  const displayParams = (mixerChannel.fields as any).displayParameters;
  if (displayParams?.fields) {
    t.update(displayParams.fields.orderAmongStrips, nextOrder);
    t.update(displayParams.fields.displayName, channelLabel);
  }

  const inputLocation = (mixerChannel.fields as any).audioInput?.location;
  if (!inputLocation) return;

  t.create("desktopAudioCable" as any, {
    fromSocket: outputField.location,
    toSocket: inputLocation,
  });
}

/**
 * Set the gain of Heisenberg's Operator A.
 */
export function setHeisenbergOperatorAGain(t: any, heisenberg: any, gain: number): void {
  const operatorA = (heisenberg.fields as any).operatorA;
  const gainField = operatorA?.fields?.gain;
  if (gainField) {
    t.update(gainField, gain);
  }
}

/** Style map for recommend-entity-for-style */
export const STYLE_MAP: Record<string, { entityType: string; reason: string }> = {
  bass: {
    entityType: "bassline",
    reason: "Bass-heavy sound is best served by the bassline monophonic synth.",
  },
  acid: {
    entityType: "bassline",
    reason: "Acid sounds (303-style) map to the bassline synth.",
  },
  sub: {
    entityType: "bassline",
    reason: "Sub-bass frequencies are the domain of the bassline synth.",
  },
  "daft punk": {
    entityType: "bassline",
    reason: "Daft Punk frequently uses monophonic synth bass lines.",
  },
  techno: {
    entityType: "machiniste",
    reason: "Techno is driven by drum machine patterns.",
  },
  drum: {
    entityType: "machiniste",
    reason: "Drum / beat requests map to the machiniste drum machine.",
  },
  beat: {
    entityType: "machiniste",
    reason: "Beat / rhythm requests map to the machiniste drum machine.",
  },
  percussion: {
    entityType: "machiniste",
    reason: "Percussion requests map to the machiniste drum machine.",
  },
  "hip hop": {
    entityType: "machiniste",
    reason: "Hip hop relies on drum machine beats.",
  },
  trap: {
    entityType: "machiniste",
    reason: "Trap is driven by drum machine patterns.",
  },
  pad: {
    entityType: "heisenberg",
    reason: "Pads and atmospheric textures map to the heisenberg polyphonic synth.",
  },
  chord: {
    entityType: "heisenberg",
    reason: "Chords need a polyphonic synth like heisenberg.",
  },
  ambient: {
    entityType: "heisenberg",
    reason: "Ambient / atmospheric sounds map to heisenberg.",
  },
  lead: {
    entityType: "heisenberg",
    reason: "Lead synth melodies map to heisenberg.",
  },
  keys: {
    entityType: "heisenberg",
    reason: "Keyboard / keys parts map to heisenberg.",
  },
  piano: {
    entityType: "heisenberg",
    reason: "Piano-like polyphonic parts map to heisenberg.",
  },
  arpeggio: {
    entityType: "tonematrix",
    reason: "Arpeggios and sequenced patterns map to the tonematrix.",
  },
  loop: {
    entityType: "tonematrix",
    reason: "Melodic loops and generative patterns map to the tonematrix.",
  },
  sequence: {
    entityType: "tonematrix",
    reason: "Step-sequenced patterns map to the tonematrix.",
  },
  delay: {
    entityType: "stompboxDelay",
    reason: "Delay / echo effects map to the stompboxDelay.",
  },
  echo: {
    entityType: "stompboxDelay",
    reason: "Echo effects map to the stompboxDelay.",
  },
  space: {
    entityType: "stompboxDelay",
    reason: "Spacey / spatial effects map to the stompboxDelay.",
  },
  reverb: {
    entityType: "stompboxDelay",
    reason: "Reverb-like spatial effects can be approximated with stompboxDelay.",
  },
};

// ─── ABC export helpers (inverse of parseAbcToNotes) ───────────────────────

const ABC_PITCH_NAMES = ["C", "^C", "D", "^D", "E", "F", "^F", "G", "^G", "A", "^A", "B"];

function gcd(a: number, b: number): number {
  a = Math.abs(a);
  b = Math.abs(b);
  while (b) { [a, b] = [b, a % b]; }
  return a;
}

/** Convert a MIDI pitch (0-127) to an ABC note name (e.g. 60 → "C", 72 → "c", 48 → "C,"). */
export function midiPitchToAbc(pitch: number): string {
  const pitchClass = ((pitch % 12) + 12) % 12;
  const octave = Math.floor(pitch / 12) - 1;
  const raw = ABC_PITCH_NAMES[pitchClass];
  const acc = raw.startsWith("^") ? "^" : "";
  const letter = acc ? raw.slice(1) : raw;

  if (octave >= 5) {
    return acc + letter.toLowerCase() + "'".repeat(octave - 5);
  }
  if (octave === 4) {
    return acc + letter;
  }
  return acc + letter + ",".repeat(Math.max(0, 4 - octave));
}

/**
 * Express `ticks` as an ABC duration suffix relative to `unitTicks` (the L: unit).
 * e.g. with L:1/8 (unitTicks = 1920): 3840 ticks → "2", 960 → "/2", 1920 → "".
 */
export function ticksToAbcDuration(ticks: number, unitTicks: number): string {
  if (ticks <= 0) return "";
  const g = gcd(ticks, unitTicks);
  const n = ticks / g;
  const d = unitTicks / g;
  if (d === 1) return n === 1 ? "" : String(n);
  if (n === 1) return `/${d}`;
  return `${n}/${d}`;
}

/**
 * Convert an array of note events (same format as parseAbcToNotes output) back
 * to a valid ABC notation string.  Simultaneous notes become chords, gaps become
 * rests, and bar lines are inserted at measure boundaries.
 */
export function notesToAbc(
  notes: ReadonlyArray<{ pitch: number; positionTicks: number; durationTicks: number; velocity: number }>,
  config?: { tempoBpm?: number; timeSignatureNum?: number; timeSignatureDen?: number },
): string {
  const bpm = config?.tempoBpm ?? 120;
  const tsNum = config?.timeSignatureNum ?? 4;
  const tsDen = config?.timeSignatureDen ?? 4;
  const unitTicks = TICKS_QUARTER / 2; // L:1/8 = 1920 ticks
  const ticksPerBar = (TICKS_WHOLE * tsNum) / tsDen;

  const header = [
    "X:1",
    "T:Exported Track",
    `M:${tsNum}/${tsDen}`,
    "L:1/8",
    `Q:1/4=${Math.round(bpm)}`,
    "K:C",
  ].join("\n");

  if (notes.length === 0) return header + "\n";

  const sorted = [...notes].sort((a, b) => a.positionTicks - b.positionTicks);

  // Group simultaneous notes into chords
  const posMap = new Map<number, Array<{ pitch: number; durationTicks: number }>>();
  for (const n of sorted) {
    const entry = { pitch: n.pitch, durationTicks: n.durationTicks };
    const arr = posMap.get(n.positionTicks);
    if (arr) arr.push(entry);
    else posMap.set(n.positionTicks, [entry]);
  }
  const positions = [...posMap.keys()].sort((a, b) => a - b);

  const tokens: string[] = [];
  let cursor = 0;

  function emitRest(ticks: number): void {
    let remaining = ticks;
    while (remaining > 0) {
      const nextBar = (Math.floor(cursor / ticksPerBar) + 1) * ticksPerBar;
      const chunk = Math.min(remaining, nextBar - cursor);
      tokens.push("z" + ticksToAbcDuration(chunk, unitTicks));
      cursor += chunk;
      remaining -= chunk;
      if (remaining > 0 && cursor % ticksPerBar === 0) {
        tokens.push("|");
      }
    }
  }

  for (const pos of positions) {
    if (pos > cursor) emitRest(pos - cursor);

    if (cursor > 0 && cursor % ticksPerBar === 0) {
      const last = tokens[tokens.length - 1];
      if (last !== "|") tokens.push("|");
    }

    const chord = posMap.get(pos)!;
    const dur = Math.max(...chord.map((c) => c.durationTicks));
    const durStr = ticksToAbcDuration(dur, unitTicks);

    if (chord.length === 1) {
      tokens.push(midiPitchToAbc(chord[0].pitch) + durStr);
    } else {
      tokens.push("[" + chord.map((c) => midiPitchToAbc(c.pitch)).join("") + "]" + durStr);
    }
    cursor = pos + dur;
  }

  tokens.push("|]");
  return header + "\n" + tokens.join(" ") + "\n";
}

export function recommendEntityForStyle(description: string): {
  entityType: string;
  reason: string;
} {
  const lower = description.toLowerCase();
  for (const [keyword, rec] of Object.entries(STYLE_MAP)) {
    if (lower.includes(keyword)) return rec;
  }
  return {
    entityType: "heisenberg",
    reason: "Heisenberg is the most versatile synth and a good default for unrecognised styles.",
  };
}
