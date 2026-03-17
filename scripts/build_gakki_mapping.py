#!/usr/bin/env python3
"""
Build Gakki instrument mapping from CuratedPresetsGakki.csv.

- Filters to sf Bank == "000"
- Maps sf Preset (0-indexed) to GM instrument names
- GM chart from http://midi.teragonaudio.com/tutr/gm.htm is 1-indexed;
  we use 0-indexing: sf_preset 60 = GM 61 French Horn
"""

import csv
import json
import os

# GM Patches: 0-indexed (index 0 = GM Prog# 1 = Acoustic Grand Piano)
# From http://midi.teragonaudio.com/tutr/gm.htm
GM_PATCHES_0_INDEXED = [
    "Acoustic Grand Piano", "Bright Acoustic", "Electric Grand", "Honky-Tonk",
    "Electric Piano 1", "Electric Piano 2", "Harpsichord", "Clavinet",
    "Celesta", "Glockenspiel", "Music Box", "Vibraphone", "Marimba", "Xylophone",
    "Tubular Bells", "Dulcimer",
    "Drawbar Organ", "Percussive Organ", "Rock Organ", "Church Organ",
    "Reed Organ", "Accordion", "Harmonica", "Tango Accordion",
    "Nylon String Guitar", "Steel String Guitar", "Electric Jazz Guitar",
    "Electric Clean Guitar", "Electric Muted Guitar", "Overdriven Guitar",
    "Distortion Guitar", "Guitar Harmonics",
    "Acoustic Bass", "Electric Bass (finger)", "Electric Bass (pick)",
    "Fretless Bass", "Slap Bass 1", "Slap Bass 2", "Synth Bass 1", "Synth Bass 2",
    "Violin", "Viola", "Cello", "Contrabass", "Tremolo Strings",
    "Pizzicato Strings", "Orchestral Strings", "Timpani",
    "String Ensemble 1", "String Ensemble 2", "SynthStrings 1", "SynthStrings 2",
    "Choir Aahs", "Voice Oohs", "Synth Voice", "Orchestra Hit",
    "Trumpet", "Trombone", "Tuba", "Muted Trumpet", "French Horn",
    "Brass Section", "SynthBrass 1", "SynthBrass 2",
    "Soprano Sax", "Alto Sax", "Tenor Sax", "Baritone Sax",
    "Oboe", "English Horn", "Bassoon", "Clarinet",
    "Piccolo", "Flute", "Recorder", "Pan Flute", "Blown Bottle",
    "Shakuhachi", "Whistle", "Ocarina",
    "Lead 1 (square)", "Lead 2 (sawtooth)", "Lead 3 (calliope)", "Lead 4 (chiff)",
    "Lead 5 (charang)", "Lead 6 (voice)", "Lead 7 (fifths)", "Lead 8 (bass+lead)",
    "Pad 1 (new age)", "Pad 2 (warm)", "Pad 3 (polysynth)", "Pad 4 (choir)",
    "Pad 5 (bowed)", "Pad 6 (metallic)", "Pad 7 (halo)", "Pad 8 (sweep)",
    "FX 1 (rain)", "FX 2 (soundtrack)", "FX 3 (crystal)", "FX 4 (atmosphere)",
    "FX 5 (brightness)", "FX 6 (goblins)", "FX 7 (echoes)", "FX 8 (sci-fi)",
    "Sitar", "Banjo", "Shamisen", "Koto", "Kalimba", "Bagpipe", "Fiddle", "Shanai",
    "Tinkle Bell", "Agogo", "Steel Drums", "Woodblock", "Taiko Drum",
    "Melodic Tom", "Synth Drum", "Reverse Cymbal",
    "Guitar Fret Noise", "Breath Noise", "Seashore", "Bird Tweet",
    "Telephone Ring", "Helicopter", "Applause", "Gunshot",
]


def main():
    # Allow override via env or default to scripts/CuratedPresetsGakki.csv
    script_dir = os.path.dirname(os.path.abspath(__file__))
    csv_path = os.environ.get(
        "GAKKI_CSV_PATH",
        os.path.join(script_dir, "CuratedPresetsGakki.csv"),
    )

    if not os.path.exists(csv_path):
        print(f"CSV not found: {csv_path}")
        print("Set GAKKI_CSV_PATH or place CuratedPresetsGakki.csv in the scripts folder")
        return 1

    # uuid -> { preset_index, gm_name, display_name }
    # gm_name (lowercase) -> uuid for reverse lookup
    by_uuid = {}
    by_gm_name = {}

    with open(csv_path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            device_type = (row.get("Preset deviceType") or "").strip().lower()
            if device_type != "gakki":
                continue

            sf_bank = (row.get("sf Bank") or "").strip()
            if sf_bank != "000":
                continue

            sf_preset_str = (row.get("sf Preset") or "").strip()
            if not sf_preset_str:
                continue

            try:
                preset_index = int(sf_preset_str)
            except ValueError:
                continue

            if preset_index < 0 or preset_index >= len(GM_PATCHES_0_INDEXED):
                continue

            uuid_val = (row.get("Preset UUID") or "").strip()
            if not uuid_val:
                continue

            display_name = (row.get("Preset displayName") or "").strip()
            gm_name = GM_PATCHES_0_INDEXED[preset_index]

            by_uuid[uuid_val] = {
                "preset_index": preset_index,
                "gm_name": gm_name,
                "display_name": display_name,
            }
            # Use lowercase for lookup; keep first if duplicate
            key = gm_name.lower().replace(" ", "_").replace("(", "").replace(")", "")
            if key not in by_gm_name:
                by_gm_name[key] = uuid_val

    out_path = os.path.join(script_dir, "..", "mcp-server", "gakki-instruments.json")

    output = {
        "by_uuid": by_uuid,
        "by_gm_name": by_gm_name,
        "gm_patches_0_indexed": GM_PATCHES_0_INDEXED,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Wrote {out_path}")
    print(f"  {len(by_uuid)} instruments (sf bank 000)")
    print(f"  {len(by_gm_name)} unique GM names")

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())
