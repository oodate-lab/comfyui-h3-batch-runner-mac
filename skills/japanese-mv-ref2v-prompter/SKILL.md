---
name: japanese-mv-ref2v-prompter
description: Turn a rough music-video concept, 1–9 ordered reference images, and optional SRT/segmented audio metadata into production-ready MiniMax H3 ref2v prompts with performance, cinematography, continuity, and reference-faithful Japanese MV direction. Do not use for dialogue-led anime scenes.
---

# Japanese MV Ref2v Prompter

Create a complete multi-clip Japanese music-video plan from the user's broad concept. Infer visual storytelling, performance, rhythm, transitions, camera language, lighting, choreography, and continuity. The web UI separately applies exact SRT lyric timing, lyric-motion design, and per-clip MP3 references after this base project is returned.

Read [references/output-schema.md](references/output-schema.md) before producing JSON. When structured output is supported, use [references/output-schema.json](references/output-schema.json).

## Reference fidelity

- Treat attachments as `<Picture 1>` through `<Picture N>` in exact order and inspect every image.
- Preserve identity, facial design, proportions, hair, clothing, props, palette, linework, shading, graphic language, and environment details.
- Do not redesign, fuse, duplicate, age-shift, or silently replace referenced subjects.
- Define stable `<Subject N>` labels and repeat all necessary definitions in every independently generated clip.
- Use `fully_preserved` for every visible referenced subject in `retention_analysis`.

## MV direction

- Build purposeful visual progression rather than unrelated beauty shots. Connect every clip to the rough concept, song structure, and adjacent clips.
- Favor polished Japanese animation, music-video editorial timing, expressive performance, readable silhouettes, natural secondary motion, and stable faces and hands.
- Translate musical energy into motivated motion: breath, gaze, pose, gesture, dance, instrument performance, environment pulses, camera acceleration, light changes, and transitions.
- Keep screen direction, subject identity, costume, props, palette, location logic, and emotional trajectory continuous.
- Do not invent spoken dialogue merely to fill time. Singing comes from the later exact audio reference; lip movement may follow singing only when the concept calls for an on-screen vocalist.

## Text and audio handoff

- The SRT text and selected lyric design are authoritative and are inserted by the web UI after generation. Do not paraphrase, translate, romanize, duplicate, or independently time lyrics.
- The web UI may insert `<Audio 1>` for each matching clip. Leave the soundscape compatible with that exact audio and do not describe replacement music, remixing, extension, or regeneration.
- Until the UI decorates the prompt, include this exact sentence in every `detailed_description`: `No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.`
- Never invent other captions, credits, titles, logos, watermarks, UI, or generated writing.

## H3 full-reference format

Each clip prompt contains exactly these six top-level sections in order: `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, `overall_soundscape`, `non_diegetic_music`.

Write directions in English. Within `detailed_description`, order shots by playback. `[Shot 1]` has no timestamp; later cuts use `[Shot N] At MM:SS.mmm, ...`. Use one to three shots per 15-second clip unless the musical idea genuinely needs another cut. Keep all action performable within the clip duration.

## Quality check

- segment count equals `ceil(totalDurationSeconds / segmentSeconds)`;
- every segment duration is positive and no longer than `segmentSeconds`;
- every supplied picture is defined and purposefully used;
- all six prompt sections occur in the required order;
- subject identity and continuity are stable across clips;
- the exact temporary visible-text prohibition appears in every base prompt;
- no invented lyric text, SRT timing, `<Audio N>`, or filler dialogue appears in the base response;
- all directions are in English.
