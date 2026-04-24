/**
 * Unit tests for MCP server utility functions.
 * Tests entity resolution, ABC parsing, Gakki presets, style recommendations, and more.
 */

import { describe, it, expect } from 'vitest';
import {
  levenshtein,
  resolveEntityType,
  resolveInstrumentType,
  resolveGmInstrumentSlug,
  resolveGmInstrumentSlugFromHints,
  resolveGmDrumSlug,
  isGmInstrumentSlug,
  isGmDrumSlug,
  parseAbcToNotes,
  normalizeAbcNotation,
  midiPitchToAbc,
  ticksToAbcDuration,
  notesToAbc,
  connectDeviceToStagebox,
  setHeisenbergOperatorAGain,
  recommendEntityForStyle,
  VALID_ENTITY_TYPES,
  ENTITY_TYPE_ALIASES,
  NOTE_TRACK_INSTRUMENTS,
  INSTRUMENT_ALIASES,
  AUDIO_OUTPUT_FIELD,
  TICKS_WHOLE,
  TICKS_QUARTER,
  GM_INSTRUMENT_SLUGS,
  GM_INSTRUMENT_SLUG_SYNONYMS,
  GM_DRUM_SLUGS,
  GM_DRUM_SLUG_SYNONYMS,
  GM_INSTRUMENT_TEXT_PATTERNS,
  STYLE_MAP,
  refId,
} from '../server-utils.js';

// ==================== LEVENSHTEIN DISTANCE TESTS ====================

describe('Levenshtein Distance', () => {
  it('should return 0 for identical strings', () => {
    expect(levenshtein('hello', 'hello')).toBe(0);
  });

  it('should return correct distance for single substitution', () => {
    expect(levenshtein('hello', 'hallo')).toBe(1);
  });

  it('should return correct distance for single deletion', () => {
    expect(levenshtein('hello', 'helo')).toBe(1);
  });

  it('should return correct distance for single insertion', () => {
    expect(levenshtein('hello', 'helllo')).toBe(1);
  });

  it('should return correct distance for completely different strings', () => {
    expect(levenshtein('abc', 'xyz')).toBe(3);
  });

  it('should be case-sensitive', () => {
    expect(levenshtein('Hello', 'hello')).toBe(1);
  });

  it('should handle empty strings', () => {
    expect(levenshtein('', 'abc')).toBe(3);
    expect(levenshtein('abc', '')).toBe(3);
    expect(levenshtein('', '')).toBe(0);
  });
});

// ==================== ENTITY TYPE RESOLUTION TESTS ====================

describe('Entity Type Resolution', () => {
  it('should resolve exact entity type matches', () => {
    expect(resolveEntityType('heisenberg')).toBe('heisenberg');
    expect(resolveEntityType('bassline')).toBe('bassline');
    expect(resolveEntityType('machiniste')).toBe('machiniste');
  });

  it('should resolve case-insensitive entity types', () => {
    expect(resolveEntityType('HEISENBERG')).toBe('heisenberg');
    expect(resolveEntityType('Bassline')).toBe('bassline');
    expect(resolveEntityType('MacHiniste')).toBe('machiniste');
  });

  it('should resolve entity type aliases', () => {
    expect(resolveEntityType('808')).toBe('beatbox8');
    expect(resolveEntityType('909')).toBe('beatbox9');
    expect(resolveEntityType('drum machine')).toBe('machiniste');
    expect(resolveEntityType('chorus')).toBe('stompboxChorus');
    expect(resolveEntityType('eq')).toBe('graphicalEQ');
    expect(resolveEntityType('sampler')).toBe('space');
  });

  it('should resolve fuzzy entity type matches within distance 3', () => {
    expect(resolveEntityType('hisenberg')).toBe('heisenberg');
    expect(resolveEntityType('machinest')).toBe('machiniste');
  });

  it('should return null for very distant strings', () => {
    expect(resolveEntityType('zzzzzzzzzzz')).toBeNull();
    expect(resolveEntityType('totallyinvalid123')).toBeNull();
  });

  it('should prefer exact match over fuzzy match', () => {
    expect(resolveEntityType('bassline')).toBe('bassline');
    expect(resolveEntityType('space')).toBe('space');
  });

  it('should trim whitespace', () => {
    expect(resolveEntityType('  heisenberg  ')).toBe('heisenberg');
  });
});

// ==================== INSTRUMENT TYPE RESOLUTION TESTS ====================

describe('Instrument Type Resolution', () => {
  it('should resolve exact instrument types', () => {
    expect(resolveInstrumentType('heisenberg')).toBe('heisenberg');
    expect(resolveInstrumentType('bassline')).toBe('bassline');
    expect(resolveInstrumentType('gakki')).toBe('gakki');
  });

  it('should resolve instrument aliases', () => {
    expect(resolveInstrumentType('synth')).toBe('heisenberg');
    expect(resolveInstrumentType('bass')).toBe('bassline');
    expect(resolveInstrumentType('drums')).toBe('machiniste');
    expect(resolveInstrumentType('pad')).toBe('heisenberg');
    expect(resolveInstrumentType('acid')).toBe('bassline');
  });

  it('should resolve orchestral instruments to gakki', () => {
    expect(resolveInstrumentType('french horn')).toBe('gakki');
    expect(resolveInstrumentType('trumpet')).toBe('gakki');
    expect(resolveInstrumentType('trombone')).toBe('gakki');
    expect(resolveInstrumentType('brass')).toBe('gakki');
    expect(resolveInstrumentType('strings')).toBe('gakki');
  });

  it('should handle fuzzy instrument matching', () => {
    expect(resolveInstrumentType('hiesenberg')).toBe('heisenberg');
    expect(resolveInstrumentType('basslne')).toBe('bassline');
  });

  it('should return null for unknown instruments', () => {
    expect(resolveInstrumentType('totallyunknown')).toBeNull();
  });
});

// ==================== GM INSTRUMENT / DRUM SLUG TESTS ====================

describe('GM Instrument Slug Resolution', () => {
  it('should expose the full SDK slug catalog (128 instruments, 8 drum kits)', () => {
    expect(GM_INSTRUMENT_SLUGS.size).toBe(128);
    expect(GM_DRUM_SLUGS.size).toBe(8);
    expect(GM_INSTRUMENT_SLUGS.has('violin')).toBe(true);
    expect(GM_INSTRUMENT_SLUGS.has('french-horn')).toBe(true);
    expect(GM_INSTRUMENT_SLUGS.has('acoustic-piano')).toBe(true);
    expect(GM_DRUM_SLUGS.has('jazz-kit')).toBe(true);
    expect(GM_DRUM_SLUGS.has('standard-kit')).toBe(true);
  });

  it('isGmInstrumentSlug narrows correctly', () => {
    expect(isGmInstrumentSlug('violin')).toBe(true);
    expect(isGmInstrumentSlug('not-a-real-slug')).toBe(false);
  });

  it('isGmDrumSlug narrows correctly', () => {
    expect(isGmDrumSlug('jazz-kit')).toBe(true);
    expect(isGmDrumSlug('violin')).toBe(false);
  });

  it('returns the slug itself when already canonical', () => {
    expect(resolveGmInstrumentSlug('violin')).toBe('violin');
    expect(resolveGmInstrumentSlug('french-horn')).toBe('french-horn');
    expect(resolveGmInstrumentSlug('marimba')).toBe('marimba');
    expect(resolveGmInstrumentSlug('pan-flute')).toBe('pan-flute');
  });

  it('normalizes input (case, whitespace, underscores)', () => {
    expect(resolveGmInstrumentSlug('  Violin  ')).toBe('violin');
    expect(resolveGmInstrumentSlug('FRENCH HORN')).toBe('french-horn');
    expect(resolveGmInstrumentSlug('french_horn')).toBe('french-horn');
    expect(resolveGmInstrumentSlug('pan flute')).toBe('pan-flute');
  });

  it('maps friendly synonyms to canonical slugs', () => {
    expect(resolveGmInstrumentSlug('piano')).toBe('acoustic-piano');
    expect(resolveGmInstrumentSlug('grand piano')).toBe('acoustic-piano');
    expect(resolveGmInstrumentSlug('acoustic grand piano')).toBe('acoustic-piano');
    expect(resolveGmInstrumentSlug('electric piano')).toBe('electronic-piano-1');
    expect(resolveGmInstrumentSlug('rhodes')).toBe('electronic-piano-1');
    expect(resolveGmInstrumentSlug('strings')).toBe('string-section');
    expect(resolveGmInstrumentSlug('brass')).toBe('brass-section');
    expect(resolveGmInstrumentSlug('horn')).toBe('french-horn');
    expect(resolveGmInstrumentSlug('sax')).toBe('alto-sax');
    expect(resolveGmInstrumentSlug('organ')).toBe('church-organ');
    expect(resolveGmInstrumentSlug('choir')).toBe('choir-aahs');
  });

  it('returns undefined for unknown inputs', () => {
    expect(resolveGmInstrumentSlug('totally-unknown-instrument')).toBeUndefined();
    expect(resolveGmInstrumentSlug('UNKNOWN THING')).toBeUndefined();
    expect(resolveGmInstrumentSlug('')).toBeUndefined();
  });

  it('synonym table points only at valid canonical slugs', () => {
    for (const slug of Object.values(GM_INSTRUMENT_SLUG_SYNONYMS)) {
      expect(GM_INSTRUMENT_SLUGS.has(slug)).toBe(true);
    }
  });

  it('text patterns all point at valid canonical slugs', () => {
    for (const { slug } of GM_INSTRUMENT_TEXT_PATTERNS) {
      expect(GM_INSTRUMENT_SLUGS.has(slug)).toBe(true);
    }
  });
});

describe('GM Drum Slug Resolution', () => {
  it('returns the slug itself when already canonical', () => {
    expect(resolveGmDrumSlug('jazz-kit')).toBe('jazz-kit');
    expect(resolveGmDrumSlug('standard-kit')).toBe('standard-kit');
  });

  it('maps friendly synonyms to canonical slugs', () => {
    expect(resolveGmDrumSlug('jazz')).toBe('jazz-kit');
    expect(resolveGmDrumSlug('room')).toBe('room-kit');
    expect(resolveGmDrumSlug('brush')).toBe('brush-kit');
    expect(resolveGmDrumSlug('brushes')).toBe('brush-kit');
    expect(resolveGmDrumSlug('orchestra')).toBe('orchestra-kit');
    expect(resolveGmDrumSlug('drums')).toBe('standard-kit');
    expect(resolveGmDrumSlug('kit')).toBe('standard-kit');
  });

  it('returns undefined for unknown kits', () => {
    expect(resolveGmDrumSlug('not-a-kit')).toBeUndefined();
  });

  it('synonym table points only at valid canonical drum slugs', () => {
    for (const slug of Object.values(GM_DRUM_SLUG_SYNONYMS)) {
      expect(GM_DRUM_SLUGS.has(slug)).toBe(true);
    }
  });
});

describe('GM Instrument Slug Resolution — hints', () => {
  it('prioritizes orchestralVoice over instrument', () => {
    expect(
      resolveGmInstrumentSlugFromHints({
        instrument: 'gakki',
        orchestralVoice: 'violin',
        abcNotation: 'X:1\nK:C\nCDEF|',
      }),
    ).toBe('violin');
  });

  it('falls back to the instrument hint when orchestralVoice is missing', () => {
    expect(
      resolveGmInstrumentSlugFromHints({
        instrument: 'french horn',
        abcNotation: 'X:1\nK:C\nCDEF|',
      }),
    ).toBe('french-horn');
  });

  it('falls back to a text-pattern match against the ABC notation', () => {
    expect(
      resolveGmInstrumentSlugFromHints({
        abcNotation: 'X:1\nT:Sunrise for Violin\nK:D\nDEFG|',
      }),
    ).toBe('violin');
  });

  it('returns undefined when no signal is available', () => {
    expect(
      resolveGmInstrumentSlugFromHints({
        instrument: 'unknown',
        orchestralVoice: 'also_unknown',
        abcNotation: 'X:1\nK:C\nCDEF|',
      }),
    ).toBeUndefined();
  });

  it('resolves piano from orchestralVoice hint', () => {
    expect(
      resolveGmInstrumentSlugFromHints({
        instrument: 'gakki',
        orchestralVoice: 'piano',
        abcNotation: 'X:1\nK:C\nCDEF|',
      }),
    ).toBe('acoustic-piano');
  });
});

// ==================== ABC NOTATION PARSING TESTS ====================

describe('ABC Notation Parsing', () => {
  it('normalizeAbcNotation inserts newlines before single-letter ABC info fields', () => {
    expect(normalizeAbcNotation('X:1 T:Title M:4/4 K:G')).toBe('X:1\nT:Title\nM:4/4\nK:G');
    expect(normalizeAbcNotation('X:1\nT:Already\nK:C')).toBe('X:1\nT:Already\nK:C');
  });

  it('should parse ABC when headers are flattened onto one line (LLM-style)', () => {
    const flattened =
      'X:1 T:Speed the Plough M:4/4 C:Trad. K:G |:GABc dedB|dedB dedB|c2ec B2dB|c2A2 A2BA| GABc dedB|dedB dedB|c2ec B2dB|A2F2 G4:| |:g2gf gdBd|g2f2 e2d2|c2ec B2dB|c2A2 A2df| g2gf g2Bd|g2f2 e2d2|c2ec B2dB|A2F2 G4:|';
    const notes = parseAbcToNotes(flattened);
    expect(notes.length).toBeGreaterThan(0);
  });

  it('should parse valid ABC notation and return notes', () => {
    const abcString = 'X:1\nK:C\nL:1/4\nCDEF|';
    const notes = parseAbcToNotes(abcString);
    expect(notes.length).toBeGreaterThan(0);
    // Notes should have required properties
    for (const note of notes) {
      expect(note).toHaveProperty('pitch');
      expect(note).toHaveProperty('positionTicks');
      expect(note).toHaveProperty('durationTicks');
      expect(note).toHaveProperty('velocity');
    }
  });

  it('should sort notes by positionTicks', () => {
    const abcString = 'X:1\nK:C\nL:1/4\nCDEF GABc|';
    const notes = parseAbcToNotes(abcString);
    for (let i = 1; i < notes.length; i++) {
      expect(notes[i].positionTicks).toBeGreaterThanOrEqual(notes[i - 1].positionTicks);
    }
  });

  it('should use default velocity of 0.7 when volume not specified', () => {
    const abcString = 'X:1\nK:C\nL:1/4\nC|';
    const notes = parseAbcToNotes(abcString);
    if (notes.length > 0) {
      // Default velocity is 0.7 when volume is null
      expect(notes[0].velocity).toBeCloseTo(0.7, 1);
    }
  });

  it('should enforce minimum duration of TICKS_QUARTER/4', () => {
    const abcString = 'X:1\nK:C\nL:1/4\nC|';
    const notes = parseAbcToNotes(abcString);
    const minDuration = TICKS_QUARTER / 4;
    for (const note of notes) {
      expect(note.durationTicks).toBeGreaterThanOrEqual(minDuration);
    }
  });

  it('should return empty array or throw on empty input', () => {
    // Empty input may return empty array or throw depending on abcjs behavior
    try {
      const notes = parseAbcToNotes('');
      expect(notes).toEqual([]);
    } catch (e) {
      expect((e as Error).message).toContain('Failed to parse ABC notation');
    }
  });

  it('should clamp pitch to 0-127 range', () => {
    const abcString = 'X:1\nK:C\nL:1/4\nCDEF|';
    const notes = parseAbcToNotes(abcString);
    for (const note of notes) {
      expect(note.pitch).toBeGreaterThanOrEqual(0);
      expect(note.pitch).toBeLessThanOrEqual(127);
    }
  });
});

// ==================== STYLE RECOMMENDATION TESTS ====================

describe('Style Recommendation', () => {
  it('should recommend bassline for Daft Punk', () => {
    const rec = recommendEntityForStyle('Daft Punk');
    expect(rec.entityType).toBe('bassline');
  });

  it('should recommend machiniste for drum keywords', () => {
    expect(recommendEntityForStyle('drum beat').entityType).toBe('machiniste');
    expect(recommendEntityForStyle('techno').entityType).toBe('machiniste');
    expect(recommendEntityForStyle('percussion').entityType).toBe('machiniste');
  });

  it('should recommend heisenberg for pads and chords', () => {
    expect(recommendEntityForStyle('warm pad').entityType).toBe('heisenberg');
    expect(recommendEntityForStyle('chord progression').entityType).toBe('heisenberg');
    expect(recommendEntityForStyle('ambient texture').entityType).toBe('heisenberg');
  });

  it('should recommend tonematrix for sequences and arpeggios', () => {
    expect(recommendEntityForStyle('arpeggio').entityType).toBe('tonematrix');
    expect(recommendEntityForStyle('sequence pattern').entityType).toBe('tonematrix');
  });

  it('should default to heisenberg for unknown styles', () => {
    const rec = recommendEntityForStyle('completely unknown style xyz');
    expect(rec.entityType).toBe('heisenberg');
    expect(rec.reason).toContain('versatile');
  });

  it('should be case-insensitive', () => {
    expect(recommendEntityForStyle('DAFT PUNK').entityType).toBe('bassline');
    expect(recommendEntityForStyle('Techno').entityType).toBe('machiniste');
  });
});

// ==================== TICK CONSTANTS TESTS ====================

describe('Tick Constants', () => {
  it('should have correct TICKS_WHOLE value', () => {
    expect(TICKS_WHOLE).toBe(15360);
  });

  it('should have correct TICKS_QUARTER value', () => {
    expect(TICKS_QUARTER).toBe(3840);
  });

  it('should have TICKS_WHOLE = 4 * TICKS_QUARTER', () => {
    expect(TICKS_WHOLE).toBe(TICKS_QUARTER * 4);
  });
});

// ==================== AUDIO OUTPUT FIELD TESTS ====================

describe('Audio Output Field Mapping', () => {
  it('should map heisenberg to audioOutput', () => {
    expect(AUDIO_OUTPUT_FIELD['heisenberg']).toBe('audioOutput');
  });

  it('should map machiniste to mainOutput', () => {
    expect(AUDIO_OUTPUT_FIELD['machiniste']).toBe('mainOutput');
  });

  it('should map beatbox8 to mainOutput', () => {
    expect(AUDIO_OUTPUT_FIELD['beatbox8']).toBe('mainOutput');
  });

  it('should map audioSplitter to audioOutput1', () => {
    expect(AUDIO_OUTPUT_FIELD['audioSplitter']).toBe('audioOutput1');
  });

  it('should map bandSplitter to highOutput', () => {
    expect(AUDIO_OUTPUT_FIELD['bandSplitter']).toBe('highOutput');
  });

  it('should map audioDevice to audioOutput', () => {
    expect(AUDIO_OUTPUT_FIELD['audioDevice']).toBe('audioOutput');
  });
});

// ==================== CONNECT DEVICE TO STAGEBOX TESTS ====================

describe('connectDeviceToStagebox', () => {
  function createMockTransaction() {
    const created: Array<{ type: string; props: any }> = [];
    const updated: Array<{ field: any; value: any }> = [];
    return {
      entities: {
        ofTypes: () => ({
          get: () => [],
        }),
      },
      create: (type: string, props: any) => {
        created.push({ type, props });
        if (type === 'mixerChannel') {
          return {
            fields: {
              displayParameters: {
                fields: {
                  orderAmongStrips: 'orderField',
                  displayName: 'nameField',
                },
              },
              audioInput: { location: 'input-loc-1' },
            },
          };
        }
        return { id: `cable-${created.length}` };
      },
      update: (field: any, value: any) => {
        updated.push({ field, value });
      },
      _created: created,
      _updated: updated,
    };
  }

  it('should create mixer channel and cable for known entity types', () => {
    const t = createMockTransaction();
    const device = {
      fields: {
        audioOutput: { location: 'output-loc-1' },
        displayName: { value: 'My Synth' },
      },
    };
    connectDeviceToStagebox(t, device, 'heisenberg');

    expect(t._created.length).toBe(2); // mixerChannel + desktopAudioCable
    expect(t._created[0].type).toBe('mixerChannel');
    expect(t._created[1].type).toBe('desktopAudioCable');
    expect(t._created[1].props.fromSocket).toBe('output-loc-1');
    expect(t._created[1].props.toSocket).toBe('input-loc-1');
  });

  it('should not create anything for unknown entity types', () => {
    const t = createMockTransaction();
    const device = { fields: { audioOutput: { location: 'loc' } } };
    connectDeviceToStagebox(t, device, 'unknownType');
    expect(t._created.length).toBe(0);
  });

  it('should not create anything if output field has no location', () => {
    const t = createMockTransaction();
    const device = { fields: { audioOutput: {} } };
    connectDeviceToStagebox(t, device, 'heisenberg');
    expect(t._created.length).toBe(0);
  });

  it('should use machiniste mainOutput field', () => {
    const t = createMockTransaction();
    const device = {
      fields: {
        mainOutput: { location: 'main-out-loc' },
        displayName: { value: 'Drum Machine' },
      },
    };
    connectDeviceToStagebox(t, device, 'machiniste');
    expect(t._created[1].props.fromSocket).toBe('main-out-loc');
  });

  it('should calculate correct orderAmongStrips with existing strips', () => {
    const t = createMockTransaction();
    // Override to return existing strips
    t.entities.ofTypes = () => ({
      get: () => [
        { fields: { displayParameters: { fields: { orderAmongStrips: { value: 0 } } } } },
        { fields: { displayParameters: { fields: { orderAmongStrips: { value: 1 } } } } },
      ],
    });
    const device = {
      fields: {
        audioOutput: { location: 'out-loc' },
        displayName: { value: '' },
      },
    };
    connectDeviceToStagebox(t, device, 'heisenberg');
    // nextOrder should be 2 (maxOrder 1 + 1)
    expect(t._updated[0].value).toBe(2);
  });
});

// ==================== SET HEISENBERG OPERATOR A GAIN TESTS ====================

describe('setHeisenbergOperatorAGain', () => {
  it('should update operator A gain field', () => {
    const updates: Array<{ field: any; value: any }> = [];
    const t = {
      update: (field: any, value: any) => updates.push({ field, value }),
    };
    const heisenberg = {
      fields: {
        operatorA: {
          fields: {
            gain: 'gainField',
          },
        },
      },
    };
    setHeisenbergOperatorAGain(t, heisenberg, 0.5);
    expect(updates.length).toBe(1);
    expect(updates[0].field).toBe('gainField');
    expect(updates[0].value).toBe(0.5);
  });

  it('should handle missing operatorA gracefully', () => {
    const updates: any[] = [];
    const t = { update: (f: any, v: any) => updates.push({ f, v }) };
    const heisenberg = { fields: {} };
    setHeisenbergOperatorAGain(t, heisenberg, 0.5);
    expect(updates.length).toBe(0);
  });
});

// ==================== CONSTANTS INTEGRITY TESTS ====================

describe('Constants Integrity', () => {
  it('should include audioDevice in VALID_ENTITY_TYPES', () => {
    expect(VALID_ENTITY_TYPES).toContain('audioDevice');
  });

  it('should have all NOTE_TRACK_INSTRUMENTS in VALID_ENTITY_TYPES', () => {
    for (const inst of NOTE_TRACK_INSTRUMENTS) {
      expect(VALID_ENTITY_TYPES).toContain(inst);
    }
  });

  it('should have all ENTITY_TYPE_ALIASES pointing to valid types', () => {
    for (const [alias, target] of Object.entries(ENTITY_TYPE_ALIASES)) {
      expect(VALID_ENTITY_TYPES).toContain(target);
    }
  });

  it('should have all INSTRUMENT_ALIASES pointing to valid note track instruments or gakki/heisenberg', () => {
    const validTargets = new Set<string>(NOTE_TRACK_INSTRUMENTS as readonly string[]);
    for (const [alias, target] of Object.entries(INSTRUMENT_ALIASES)) {
      expect(validTargets.has(target)).toBe(true);
    }
  });

  it('should have all AUDIO_OUTPUT_FIELD keys be valid entity types or known types', () => {
    const validSet = new Set(VALID_ENTITY_TYPES as readonly string[]);
    for (const key of Object.keys(AUDIO_OUTPUT_FIELD)) {
      expect(validSet.has(key)).toBe(true);
    }
  });

  it('should have all STYLE_MAP values pointing to valid entity types', () => {
    const validSet = new Set(VALID_ENTITY_TYPES as readonly string[]);
    for (const [key, rec] of Object.entries(STYLE_MAP)) {
      expect(validSet.has(rec.entityType)).toBe(true);
    }
  });
});

// ==================== midiPitchToAbc TESTS ====================

describe('midiPitchToAbc', () => {
  it('should convert middle C (MIDI 60) to "C"', () => {
    expect(midiPitchToAbc(60)).toBe('C');
  });

  it('should convert MIDI 72 (C5) to lowercase "c"', () => {
    expect(midiPitchToAbc(72)).toBe('c');
  });

  it('should convert MIDI 48 (C3) to "C,"', () => {
    expect(midiPitchToAbc(48)).toBe('C,');
  });

  it('should convert MIDI 36 (C2) to "C,,"', () => {
    expect(midiPitchToAbc(36)).toBe('C,,');
  });

  it('should convert MIDI 84 (C6) to "c\'"', () => {
    expect(midiPitchToAbc(84)).toBe("c'");
  });

  it('should handle sharps with ^', () => {
    expect(midiPitchToAbc(61)).toBe('^C');
    expect(midiPitchToAbc(73)).toBe('^c');
  });

  it('should convert natural notes correctly across octave 4', () => {
    expect(midiPitchToAbc(60)).toBe('C');
    expect(midiPitchToAbc(62)).toBe('D');
    expect(midiPitchToAbc(64)).toBe('E');
    expect(midiPitchToAbc(65)).toBe('F');
    expect(midiPitchToAbc(67)).toBe('G');
    expect(midiPitchToAbc(69)).toBe('A');
    expect(midiPitchToAbc(71)).toBe('B');
  });

  it('should handle MIDI 0 (very low pitch)', () => {
    const result = midiPitchToAbc(0);
    expect(result).toBe('C,,,,,');
  });
});

// ==================== ticksToAbcDuration TESTS ====================

describe('ticksToAbcDuration', () => {
  const EIGHTH = TICKS_QUARTER / 2; // 1920

  it('should return empty string for one unit (eighth note)', () => {
    expect(ticksToAbcDuration(EIGHTH, EIGHTH)).toBe('');
  });

  it('should return "2" for a quarter note (2 eighths)', () => {
    expect(ticksToAbcDuration(TICKS_QUARTER, EIGHTH)).toBe('2');
  });

  it('should return "4" for a half note', () => {
    expect(ticksToAbcDuration(TICKS_QUARTER * 2, EIGHTH)).toBe('4');
  });

  it('should return "8" for a whole note', () => {
    expect(ticksToAbcDuration(TICKS_WHOLE, EIGHTH)).toBe('8');
  });

  it('should return "/2" for a sixteenth note', () => {
    expect(ticksToAbcDuration(TICKS_QUARTER / 4, EIGHTH)).toBe('/2');
  });

  it('should return "3" for a dotted quarter (3 eighths)', () => {
    expect(ticksToAbcDuration(EIGHTH * 3, EIGHTH)).toBe('3');
  });
});

// ==================== notesToAbc TESTS ====================

describe('notesToAbc', () => {
  it('should produce valid ABC header for empty notes', () => {
    const abc = notesToAbc([]);
    expect(abc).toContain('X:1');
    expect(abc).toContain('M:4/4');
    expect(abc).toContain('L:1/8');
    expect(abc).toContain('K:C');
  });

  it('should convert a single quarter-note C4', () => {
    const abc = notesToAbc([
      { pitch: 60, positionTicks: 0, durationTicks: TICKS_QUARTER, velocity: 0.7 },
    ]);
    expect(abc).toContain('C2');
    expect(abc).toContain('|]');
  });

  it('should insert a rest for a gap', () => {
    const abc = notesToAbc([
      { pitch: 60, positionTicks: TICKS_QUARTER, durationTicks: TICKS_QUARTER, velocity: 0.7 },
    ]);
    expect(abc).toContain('z2');
    expect(abc).toContain('C2');
  });

  it('should group simultaneous notes into chords', () => {
    const abc = notesToAbc([
      { pitch: 60, positionTicks: 0, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 64, positionTicks: 0, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 67, positionTicks: 0, durationTicks: TICKS_QUARTER, velocity: 0.7 },
    ]);
    expect(abc).toContain('[CEG]2');
  });

  it('should use custom tempo and time signature from config', () => {
    const abc = notesToAbc([], { tempoBpm: 140, timeSignatureNum: 3, timeSignatureDen: 4 });
    expect(abc).toContain('Q:1/4=140');
    expect(abc).toContain('M:3/4');
  });

  it('should insert bar lines at measure boundaries', () => {
    const ticksPerBar = TICKS_WHOLE; // 4/4 = one whole note per bar
    const notes = [
      { pitch: 60, positionTicks: 0, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 62, positionTicks: TICKS_QUARTER, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 64, positionTicks: TICKS_QUARTER * 2, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 65, positionTicks: TICKS_QUARTER * 3, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 67, positionTicks: ticksPerBar, durationTicks: TICKS_QUARTER, velocity: 0.7 },
    ];
    const abc = notesToAbc(notes);
    expect(abc).toContain('|');
    const body = abc.split('K:C\n')[1];
    expect(body).toContain('C2 D2 E2 F2 | G2');
  });

  it('should round-trip with parseAbcToNotes for a simple scale', () => {
    const original = [
      { pitch: 60, positionTicks: 0, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 62, positionTicks: TICKS_QUARTER, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 64, positionTicks: TICKS_QUARTER * 2, durationTicks: TICKS_QUARTER, velocity: 0.7 },
      { pitch: 65, positionTicks: TICKS_QUARTER * 3, durationTicks: TICKS_QUARTER, velocity: 0.7 },
    ];
    const abc = notesToAbc(original);
    const parsed = parseAbcToNotes(abc);
    expect(parsed.length).toBe(4);
    for (let i = 0; i < original.length; i++) {
      expect(parsed[i].pitch).toBe(original[i].pitch);
      expect(parsed[i].positionTicks).toBe(original[i].positionTicks);
      expect(parsed[i].durationTicks).toBe(original[i].durationTicks);
    }
  });
});

// ==================== refId HELPER TESTS ====================

describe('refId', () => {
  it('should extract entityId from a NexusLocation-style value', () => {
    const field = { value: { entityId: 'abc-123', entityType: 'noteTrack' } };
    expect(refId(field)).toBe('abc-123');
  });

  it('should return string value directly', () => {
    const field = { value: 'some-string-id' };
    expect(refId(field)).toBe('some-string-id');
  });

  it('should return null for null/undefined field', () => {
    expect(refId(null)).toBeNull();
    expect(refId(undefined)).toBeNull();
  });

  it('should return null when field has no value', () => {
    expect(refId({})).toBeNull();
    expect(refId({ location: { entityId: 'x' } })).toBeNull();
  });

  it('should return null when value has no entityId', () => {
    const field = { value: { somethingElse: 42 } };
    expect(refId(field)).toBeNull();
  });

  it('should handle field with numeric value gracefully', () => {
    const field = { value: 42 };
    expect(refId(field)).toBeNull();
  });
});
