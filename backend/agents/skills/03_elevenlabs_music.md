# ElevenLabs AI music (agent tool)

When the user asks for **AI-generated music from a text description** (e.g. “15 seconds of lo-fi hip hop”, “cinematic strings bed”), call the tool **`generate-music-elevenlabs`** with:

- **`prompt`** (required): Their creative brief—genre, mood, tempo, instruments. Prefer describing style and mood; if generation fails, retry with a generic style description and avoid naming specific tunes or copyrighted titles. When the user asks for a specific instrument (e.g. "bass guitar", "piano", "drum loop"), always include "solo [instrument] only, no other instruments, no accompaniment, no backing" in the prompt to ensure only that instrument appears in the sample. Assume a single-instrument request unless the user explicitly asks for multiple instruments or a full arrangement.
- **`music_length_ms`** (optional): Length in milliseconds; default **15000** (15s). Valid range 3000–600000.
- **`force_instrumental`** (optional): Default **true** (no vocals). Set **false** only if they explicitly want vocals.

**Do not** use this tool for ABC notation or scored melodies—use **`add-abc-track`** instead.

If generation fails (e.g. no API key), explain briefly and suggest setting the ElevenLabs API key in the Settings menu under "ElevenLabs API Key".

## Matching the user's project

You may receive a `[DAW project context]` hint containing the project's tempo (BPM), time signature, and instruments. When the user explicitly wants the sample to match or fit their current project (e.g. "generate something that fits my project", "make a bass line for this"), use the following workflow:

1. **Get the full picture**: Call `get-project-summary` and `export-tracks-abc` — these are independent reads and can be called in parallel to save time.
2. **Analyze**: Use the summary to understand instruments/effects/routing and the ABC export to determine key, scale, and chord progression.
3. **Build a rich prompt**: Combine your analysis with the project's tempo and the user's request into a detailed ElevenLabs prompt. Example: "120 BPM, C minor, funky slap bass line, complementing piano chords Cm-Eb-Ab-G progression, 8 bars, instrumental."
4. **Ask only if needed**: If you cannot determine the key or style from the existing tracks and the user hasn't specified, ask for clarification. But if you can infer it from the note content, skip asking and generate.

If the user asks for a standalone sample without referencing the project, rely solely on their description and ignore the project context.

When the project has no note tracks (e.g. empty project), fall back to asking the user for key, genre, mood, and instruments — the same details you would need to generate a good prompt.
