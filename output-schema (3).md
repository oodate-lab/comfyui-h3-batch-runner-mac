# Output schema

Return one JSON object and no Markdown fence or commentary. Use the same project contract as the bundled anime mode so the shared Batch controller can validate and execute either mode.

```json
{
  "title": "Short project title",
  "totalDurationSeconds": 30,
  "segmentSeconds": 15,
  "referenceAnalysis": [{ "picture": 1, "subjectId": "Subject 1", "role": "performer or visual element", "observedTraits": "Only traits visible in the reference" }],
  "voiceCast": [],
  "continuityBible": "Stable English continuity rules shared by all clips",
  "segments": [{
    "id": "clip_01",
    "number": 1,
    "startSeconds": 0,
    "durationSeconds": 15,
    "sourceRange": "00:00–00:15",
    "synopsis": "Short Japanese summary for the web UI",
    "dialoguePreview": "MV演出",
    "prompt": "subject_definitions:\n...\n\nsummary:\n...\n\nretention_analysis:\n...\n\ndetailed_description:\n...\n\noverall_soundscape:\n...\n\nnon_diegetic_music:\n..."
  }]
}
```

The final segment may be shorter. `referenceAnalysis` contains one ordered entry per picture. `voiceCast` is normally empty in MV mode. Every segment prompt is self-contained and repeats its required definitions and continuity facts.
