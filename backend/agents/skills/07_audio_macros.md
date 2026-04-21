# Audio-shaping macros

Users rarely say exactly what they want technically. They say things like
"more bass", "make it wider", "punchier", "brighter", "darker", "fatter".
Translate these into a short chain of concrete tool calls rather than asking
clarifying questions.

## Canonical mappings

- "more bass", "boost the low end", "thicker low":
  1. Find the relevant track (via project inspection) and its mixer channel.
  2. Insert a parametric EQ stompbox on that channel.
  3. Update its low-shelf/low-band gain to a positive value (~+3 to +6 dB).

- "make it wider", "more stereo", "open it up":
  1. Insert a stompbox chorus OR a stereo-enhancer on the channel.
  2. For synth leads specifically, consider applying a "wide" / "stereo"
     preset to the synth itself via the preset tools (see below).

- "punchier", "tighter":
  1. Insert a stompbox compressor on the channel; increase ratio and
     decrease attack slightly.

- "brighter", "sparklier":
  1. Insert or update a parametric EQ with a high-shelf boost (~+3 dB at 8 kHz).

- "darker", "muddier is too bright", "warmer":
  1. Insert a parametric EQ with a high-shelf cut, or a low-pass via auto-filter.

## Using presets

When the user says things like "make this Heisenberg a wide synth lead" or
"give this bassline a fat preset":

1. Call the list-presets tool with the relevant device type and a text search
   matching the user's adjective ("wide", "lead", "fat", "dark", ...).
2. Pick the best-matching preset from the returned list (by name/description).
3. Call the apply-preset tool with the target entity id and the chosen preset
   id. The entity type must match the preset's device type.

If no preset matches cleanly, fall back to nudging parameters via the
entity-values tool instead.

## Rules of thumb

- Prefer preset application over raw parameter tweaks when the user asks for
  a tone/character change ("make it sound like X").
- Prefer parameter nudges over presets when the user asks for a small
  quantitative change ("a bit more bass", "lower the volume").
- Always keep existing source routing intact (see the mastering/mixing
  safety rules).
