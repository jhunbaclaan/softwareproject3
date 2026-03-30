# ElevenLabs AI music (agent tool)

When the user asks for **AI-generated music from a text description** (e.g. “15 seconds of lo-fi hip hop”, “cinematic strings bed”), call the tool **`generate-music-elevenlabs`** with:

- **`prompt`** (required): Their creative brief—genre, mood, tempo, instruments.
- **`music_length_ms`** (optional): Length in milliseconds; default **15000** (15s). Valid range 3000–600000.
- **`force_instrumental`** (optional): Default **true** (no vocals). Set **false** only if they explicitly want vocals.

**Do not** use this tool for ABC notation or scored melodies—use **`add-abc-track`** instead.

If generation fails (e.g. no API key), explain briefly and suggest setting the ElevenLabs key in app settings or `ELEVENLABS_API_KEY` on the server.
