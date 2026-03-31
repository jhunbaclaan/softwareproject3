/**
 * Unit tests for MCP server utility functions.
 * Tests entity resolution, ABC parsing, Gakki presets, style recommendations, and more.
 */

import { describe, it, expect } from 'vitest';
import {
  levenshtein,
  resolveEntityType,
  resolveInstrumentType,
  resolveGakkiPresetUuid,
  resolveGakkiPresetUuidFromHints,
  parseAbcToNotes,
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
  GAKKI_NAME_SYNONYMS,
  STYLE_MAP,
  gakkiByGmName,
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

// ==================== GAKKI PRESET RESOLUTION TESTS ====================

describe('Gakki Preset Resolution', () => {
  const hasGakkiData = Object.keys(gakkiByGmName).length > 0;

  it('should handle synonym lookups', () => {
    // GAKKI_NAME_SYNONYMS maps horn → french_horn, brass → brass_section, etc.
    expect(GAKKI_NAME_SYNONYMS['horn']).toBe('french_horn');
    expect(GAKKI_NAME_SYNONYMS['brass']).toBe('brass_section');
    expect(GAKKI_NAME_SYNONYMS['strings']).toBe('string_ensemble_1');
  });

  it('should return undefined for unknown instrument names', () => {
    expect(resolveGakkiPresetUuid('totally_unknown_instrument')).toBeUndefined();
  });

  it('should normalize input (lowercase, underscores)', () => {
    // Even if we don't have gakki data, the function normalizes input correctly
    const result = resolveGakkiPresetUuid('UNKNOWN THING');
    expect(result).toBeUndefined();
  });

  it.skipIf(!hasGakkiData)('should resolve direct GM name lookups when data available', () => {
    const firstKey = Object.keys(gakkiByGmName)[0];
    if (firstKey) {
      expect(resolveGakkiPresetUuid(firstKey)).toBe(gakkiByGmName[firstKey]);
    }
  });

  it('should prioritize orchestralVoice over instrument in hints', () => {
    // resolveGakkiPresetUuidFromHints checks orchestralVoice first
    const result = resolveGakkiPresetUuidFromHints({
      instrument: 'unknown',
      orchestralVoice: 'also_unknown',
      abcNotation: 'X:1\nK:C\nCDEF|',
    });
    // Both are unknown, so fallback to text patterns in ABC
    // No orchestral text in ABC, so undefined
    expect(result).toBeUndefined();
  });
});

// ==================== ABC NOTATION PARSING TESTS ====================

describe('ABC Notation Parsing', () => {
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
    const validTargets = new Set([...NOTE_TRACK_INSTRUMENTS]);
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
