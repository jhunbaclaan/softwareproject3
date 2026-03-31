# ElevenLabs AI music (agent tool)

When the user asks for **AI-generated music from a text description** (e.g. “15 seconds of lo-fi hip hop”, “cinematic strings bed”), call the tool **`generate-music-elevenlabs`** with:

- **`prompt`** (required): Their creative brief—genre, mood, tempo, instruments.
- **`music_length_ms`** (optional): Length in milliseconds; default **15000** (15s). Valid range 3000–600000.
- **`force_instrumental`** (optional): Default **true** (no vocals). Set **false** only if they explicitly want vocals.

**Do not** use this tool for ABC notation or scored melodies—use **`add-abc-track`** instead.

If generation fails (e.g. no API key), explain briefly and suggest setting the ElevenLabs key in app settings or `ELEVENLABS_API_KEY` on the server.

## Matching the user's project

You may receive a `[DAW project context]` hint containing the project's tempo (BPM) and time signature. **Only** use these details when the user explicitly wants the sample to match or fit their current project (e.g. "generate something that fits my project", "make a beat that matches what I have"). If the user asks for a standalone sample without referencing the project, rely solely on their description.

When the user wants a sample to match their project, **before generating**, ask if they can share a few extra details that are not available from the DAW automatically. Suggest specifics like:
- **Key** (e.g. C minor, F# major)
- **Genre / style** (e.g. lo-fi hip hop, house, ambient)
- **Mood / energy** (e.g. dark, upbeat, chill)
- **Instruments** (e.g. piano, synth pad, acoustic drums)

Mention what you already know from the project context (e.g. "I can see your project is at 120 BPM in 4/4 time") and explain that adding details like key and genre will help the sample fit better. If the user has already provided enough detail (key, genre, etc.) in their message, or tells you to just go ahead, skip the suggestions and generate immediately using the DAW context plus whatever they gave you.
