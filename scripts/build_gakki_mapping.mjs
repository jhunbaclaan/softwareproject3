#!/usr/bin/env node
/**
 * Build Gakki instrument mapping from CuratedPresetsGakki.csv.
 * - Filters to sf Bank == "000"
 * - Maps sf Preset (0-indexed) to GM instrument names
 * - GM chart from http://midi.teragonaudio.com/tutr/gm.htm is 1-indexed;
 *   we use 0-indexing: sf_preset 60 = GM 61 French Horn
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// GM Patches: 0-indexed (index 0 = GM Prog# 1 = Acoustic Grand Piano)
const GM_PATCHES_0_INDEXED = [
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
];

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return [];
  const header = lines[0].split(",").map((h) => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    const row = {};
    header.forEach((h, j) => {
      row[h] = values[j] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === "," && !inQuotes) || (c === "\n" && !inQuotes)) {
      result.push(current.trim());
      current = "";
    } else {
      current += c;
    }
  }
  result.push(current.trim());
  return result;
}

function main() {
  const csvPath =
    process.env.GAKKI_CSV_PATH ||
    path.join(__dirname, "CuratedPresetsGakki.csv");

  if (!fs.existsSync(csvPath)) {
    console.error(`CSV not found: ${csvPath}`);
    console.error("Set GAKKI_CSV_PATH or place CuratedPresetsGakki.csv in Downloads");
    process.exit(1);
  }

  const csvText = fs.readFileSync(csvPath, "utf-8");
  const rows = parseCSV(csvText);

  const by_uuid = {};
  const by_gm_name = {};

  for (const row of rows) {
    const deviceType = (row["Preset deviceType"] ?? "").trim().toLowerCase();
    if (deviceType !== "gakki") continue;

    const sfBank = (row["sf Bank"] ?? "").trim();
    if (sfBank !== "000") continue;

    const sfPresetStr = (row["sf Preset"] ?? "").trim();
    if (!sfPresetStr) continue;

    const presetIndex = parseInt(sfPresetStr, 10);
    if (isNaN(presetIndex) || presetIndex < 0 || presetIndex >= GM_PATCHES_0_INDEXED.length) continue;

    const uuidVal = (row["Preset UUID"] ?? "").trim();
    if (!uuidVal) continue;

    const displayName = (row["Preset displayName"] ?? "").trim();
    const gmName = GM_PATCHES_0_INDEXED[presetIndex];

    by_uuid[uuidVal] = {
      preset_index: presetIndex,
      gm_name: gmName,
      display_name: displayName,
    };

    const key = gmName.toLowerCase().replace(/\s+/g, "_").replace(/[()]/g, "");
    if (!(key in by_gm_name)) {
      by_gm_name[key] = uuidVal;
    }
  }

  const outPath = path.join(__dirname, "..", "mcp-server", "gakki-instruments.json");
  const output = {
    by_uuid,
    by_gm_name,
    gm_patches_0_indexed: GM_PATCHES_0_INDEXED,
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`Wrote ${outPath}`);
  console.log(`  ${Object.keys(by_uuid).length} instruments (sf bank 000)`);
  console.log(`  ${Object.keys(by_gm_name).length} unique GM names`);
}

main();
