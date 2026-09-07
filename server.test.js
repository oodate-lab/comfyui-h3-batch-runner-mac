import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodexExecArgs, buildCodexSearchCandidates, extractHistoryExecutionError, extractJsonObject, formatComfyExecutionError, inspectRunPreflight, patchWorkflow, testCodexCli, validateAnimeProject } from '../server.js';

function h3Prompt(picture = 1, dialogue = 'こんにちは。') {
  return `subject_definitions:\n<Subject 1> is the character in <Picture ${picture}>.\n\nsummary:\nA Japanese anime scene.\n\nretention_analysis:\n<Subject 1>: fully_preserved.\n\ndetailed_description:\nNo visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing. [Shot 1] <Subject 1> (S1) speaks with precise lip sync, <d>[Japanese] ${dialogue}</d>\n\noverall_soundscape:\nClean room tone and synchronized dialogue.\n\nnon_diegetic_music:\nN/A`;
}

test('Codex exec arguments use read-only structured output and ordered images', () => {
  const args = buildCodexExecArgs({
    model: 'gpt-test', schemaPath: '/tmp/schema.json', outputPath: '/tmp/output.json',
    imagePaths: ['/tmp/picture-1.png', '/tmp/picture-2.png'],
  });
  assert.deepEqual(args, [
    'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', '/tmp/schema.json', '-o', '/tmp/output.json',
    '--model', 'gpt-test', '--image', '/tmp/picture-1.png', '--image', '/tmp/picture-2.png', '-',
  ]);
});

test('Windows Codex discovery searches PATH and standard npm folders', () => {
  const candidates = buildCodexSearchCandidates('codex', {
    PATH: 'C:\\Tools',
    APPDATA: 'C:\\Users\\Akita\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Akita\\AppData\\Local',
  }, 'win32');
  assert.ok(candidates.includes('C:\\Tools\\codex.cmd'));
  assert.ok(candidates.includes('C:\\Users\\Akita\\AppData\\Roaming\\npm\\codex.cmd'));
  assert.ok(candidates.includes('C:\\Users\\Akita\\AppData\\Local\\npm\\codex.cmd'));
});

test('macOS Codex discovery searches Homebrew and user npm folders', () => {
  const candidates = buildCodexSearchCandidates('codex', {
    PATH: '/usr/bin:/bin',
    HOME: '/Users/akita',
    npm_config_prefix: '/Users/akita/.npm',
  }, 'darwin');
  assert.ok(candidates.includes('/opt/homebrew/bin/codex'));
  assert.ok(candidates.includes('/usr/local/bin/codex'));
  assert.ok(candidates.includes('/Users/akita/.npm-global/bin/codex'));
  assert.ok(candidates.includes('/Users/akita/.npm/bin/codex'));
});

test('missing Codex CLI returns an actionable Japanese installation message', async () => {
  await assert.rejects(
    () => testCodexCli({ codexCommand: 'codex-definitely-not-installed-for-test' }),
    /npm install -g @openai\/codex.*where\.exe codex/,
  );
});

test('patchWorkflow replaces prompt and reference images without an audio mapping', () => {
  const base = {
    '1': { class_type: 'Text', inputs: { text: 'old' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    '3': { class_type: 'Save', inputs: { filename_prefix: 'old' } },
    '4': { class_type: 'Sampler', inputs: { seed: 0 } },
  };
  const patched = patchWorkflow(base, { id: 'clip_01', index: 2, prompt: 'new prompt' }, {
    prompt: { nodeId: '1', inputKey: 'text' },
    images: [{ nodeId: '2', inputKey: 'image', uploadIndex: 0 }],
    filename: { nodeId: '3', inputKey: 'filename_prefix' },
    seeds: [{ nodeId: '4', inputKey: 'seed' }], baseSeed: 100, outputPrefix: 'anime',
  }, { images: ['batch/ref.png'] });
  assert.equal(patched['1'].inputs.text, 'new prompt');
  assert.equal(patched['2'].inputs.image, 'batch/ref.png');
  assert.equal(patched['3'].inputs.filename_prefix, 'anime/clip_01');
  assert.equal(patched['4'].inputs.seed, 102);
  assert.equal(base['1'].inputs.text, 'old');
});

test('patchWorkflow supports nine independently mapped reference images', () => {
  const base = { text: { class_type: 'Text', inputs: { text: 'old' } } };
  const mappings = [];
  const paths = [];
  for (let index = 1; index <= 9; index += 1) {
    base[`image${index}`] = { class_type: 'LoadImage', inputs: { image: 'old.png' } };
    mappings.push({ nodeId: `image${index}`, inputKey: 'image', uploadIndex: index - 1 });
    paths.push(`batch/ref${index}.png`);
  }
  const patched = patchWorkflow(base, { id: 'clip_01', prompt: 'nine pictures' }, {
    prompt: { nodeId: 'text', inputKey: 'text' }, images: mappings,
  }, { images: paths });
  for (let index = 1; index <= 9; index += 1) assert.equal(patched[`image${index}`].inputs.image, `batch/ref${index}.png`);
});

test('patchWorkflow maps the matching MP3 by clip number', () => {
  const patched = patchWorkflow({
    text: { class_type: 'Text', inputs: { text: 'old' } },
    audio: { class_type: 'LoadAudio', inputs: { audio: 'old.mp3' } },
  }, { id: 'clip_02', number: 2, prompt: 'p' }, {
    prompt: { nodeId: 'text', inputKey: 'text' },
    images: [], audio: { nodeId: 'audio', inputKey: 'audio' },
  }, { images: [], audio: ['batch/audio001.mp3', 'batch/audio002.mp3'] });
  assert.equal(patched.audio.inputs.audio, 'batch/audio002.mp3');
});

test('patchWorkflow rejects graph connections, wrong types, and missing images', () => {
  assert.throws(() => patchWorkflow({
    primitive: { class_type: 'Primitive', inputs: { value: 'old' } },
    h3: { class_type: 'H3', inputs: { prompt: ['primitive', 0] } },
  }, { id: 'clip_01', prompt: 'new' }, { prompt: { nodeId: 'h3', inputKey: 'prompt' }, images: [] }, { images: [] }), /connection from node primitive/);
  assert.throws(() => patchWorkflow({ text: { class_type: 'Primitive', inputs: { value: 1 } } }, { id: 'x', prompt: 'new' }, {
    prompt: { nodeId: 'text', inputKey: 'value' }, images: [],
  }, { images: [] }), /is number.*assign string/);
  assert.throws(() => patchWorkflow({
    text: { class_type: 'Text', inputs: { text: 'old' } }, image: { class_type: 'LoadImage', inputs: { image: '' } },
  }, { id: 'x', prompt: 'new' }, { prompt: { nodeId: 'text', inputKey: 'text' }, images: [{ nodeId: 'image', inputKey: 'image' }] }, { images: [] }), /Picture 1.*no staged image/);
});

test('extractJsonObject accepts fenced JSON', () => {
  assert.deepEqual(extractJsonObject('```json\n{"ok":true}\n```'), { ok: true });
});

test('validateAnimeProject normalizes timing and accepts native Japanese dialogue', () => {
  const raw = {
    title: 'Test',
    referenceAnalysis: [{ picture: 1 }],
    voiceCast: [{ speakerId: 'S1', voiceDirection: 'youthful and clear' }],
    continuityBible: 'Keep S1 stable.',
    segments: [
      { synopsis: '前半', dialoguePreview: 'こんにちは', prompt: h3Prompt(1, 'こんにちは。') },
      { synopsis: '後半', dialoguePreview: 'またね', prompt: h3Prompt(1, 'またね。') },
    ],
  };
  const project = validateAnimeProject(raw, { totalDurationSeconds: 20, segmentSeconds: 15, referenceCount: 1 });
  assert.equal(project.segments.length, 2);
  assert.equal(project.segments[0].durationSeconds, 15);
  assert.equal(project.segments[1].durationSeconds, 5);
  assert.equal(project.segments[1].sourceRange, '00:15–00:20');
});

test('validateAnimeProject rejects audio references, then repairs missing pictures and subtitle exclusions', () => {
  const base = { title: 'X', referenceAnalysis: [{ picture: 1 }], segments: [{ prompt: h3Prompt(1) }] };
  assert.throws(() => validateAnimeProject({ ...base, segments: [{ prompt: h3Prompt(1).replace('N/A', '<Audio 1>') }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 }), /Audio/);
  const picturesRepaired = validateAnimeProject({ ...base, referenceAnalysis: [{ picture: 1 }, { picture: 2 }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 2 });
  assert.match(picturesRepaired.segments[0].prompt, /<Picture 2> is an ordered visual reference/);
  assert.match(picturesRepaired.autoRepairs.join('\n'), /<Picture 2>/);
  const repaired = validateAnimeProject({ ...base, segments: [{ prompt: h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing. ', '') }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(repaired.segments[0].prompt, /No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing\./);
});

test('validateAnimeProject normalizes common Japanese dialogue tags and allows a dialogue-free clip', () => {
  const base = { title: 'X', referenceAnalysis: [{ picture: 1 }] };
  const jpTag = h3Prompt(1).replace('[Japanese]', '[日本語]');
  const normalized = validateAnimeProject({ ...base, segments: [{ prompt: jpTag }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(normalized.segments[0].prompt, /<d>\[Japanese\] こんにちは。<\/d>/);
  const silent = h3Prompt(1).replace(/<d>\[Japanese\][\s\S]+?<\/d>/, 'silently reacts with a small breath');
  const accepted = validateAnimeProject({ ...base, segments: [{ prompt: silent }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(accepted.validationWarnings.join('\n'), /台詞なしのクリップとして続行/);
});

test('MV validation uses the MV generator policy and does not require dialogue', () => {
  const silentPrompt = h3Prompt(1).replace(/<d>\[Japanese\][\s\S]+?<\/d>/, 'performs silently to the musical pulse');
  const project = validateAnimeProject({
    title: 'MV', referenceAnalysis: [{ picture: 1 }], voiceCast: [],
    segments: [{ synopsis: '歌唱シーン', dialoguePreview: '', prompt: silentPrompt }],
  }, { mode: 'mv', totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.equal(project.mode, 'mv');
  assert.equal(project.generator.mode, 'mv');
  assert.equal(project.generator.visibleTextPolicy, 'web-srt');
  assert.equal(project.validationWarnings.some((warning) => /台詞タグ/.test(warning)), false);
});

test('MV preflight accepts web-applied lyrics and matching audio', () => {
  const prompt = h3Prompt(1)
    .replace('No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.', 'Lyric motion graphics (ターコイズ・ミニマル): clean typography. At 00:01.000–00:03.000, display only the exact Japanese lyric text 「光る」. Do not add any other subtitles, captions, titles, credits, logos, watermarks, UI, or generated writing.')
    .replace('non_diegetic_music:', '<Audio 1> is the exact matching MP3 segment for this clip.\n\nnon_diegetic_music:');
  const result = inspectRunPreflight({
    segments: [{ id: 'clip_01', number: 1, prompt, audioReference: true, lyricCues: [{ text: '光る' }] }],
    workflow: {
      text: { class_type: 'Text', inputs: { text: 'old' } },
      image: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
      audio: { class_type: 'LoadAudio', inputs: { audio: 'old.mp3' } },
    },
    config: {
      prompt: { nodeId: 'text', inputKey: 'text' },
      images: [{ nodeId: 'image', inputKey: 'image', uploadIndex: 0 }],
      audio: { nodeId: 'audio', inputKey: 'audio' }, seeds: [],
    },
    imageCount: 1, audioCount: 1,
    generator: { type: 'codex-cli', mode: 'mv', visibleTextPolicy: 'web-srt' },
  });
  assert.equal(result.ok, true);
});

test('validateAnimeProject accepts equivalent subtitle prohibitions but rejects display instructions', () => {
  const base = { title: 'X', referenceAnalysis: [{ picture: 1 }] };
  const equivalent = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.', 'Subtitles and captions are strictly prohibited; all dialogue remains audio-only.');
  const accepted = validateAnimeProject({ ...base, segments: [{ prompt: equivalent }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(accepted.segments[0].prompt, /strictly prohibited/);
  assert.match(accepted.segments[0].prompt, /title cards, watermarks/);
  const imperative = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.', 'Do not display subtitles or captions at any time.');
  const imperativeAccepted = validateAnimeProject({ ...base, segments: [{ prompt: imperative }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 });
  assert.match(imperativeAccepted.segments[0].prompt, /Do not display subtitles/);
  const visible = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.', 'Display subtitles for every Japanese line.');
  assert.throws(() => validateAnimeProject({ ...base, segments: [{ prompt: visible }] }, { totalDurationSeconds: 15, segmentSeconds: 15, referenceCount: 1 }), /字幕を表示する指示/);
});

test('run preflight blocks missing subtitle prohibition and validates picture, prompt and seed mappings', () => {
  const workflow = {
    text: { class_type: 'Text', inputs: { text: 'old' } },
    image: { class_type: 'LoadImage', inputs: { image: 'old.png' } },
    sampler: { class_type: 'Sampler', inputs: { seed: 1 } },
  };
  const config = {
    prompt: { nodeId: 'text', inputKey: 'text' },
    images: [{ nodeId: 'image', inputKey: 'image', uploadIndex: 0 }],
    seeds: [{ nodeId: 'sampler', inputKey: 'seed' }], baseSeed: 99,
  };
  const generator = { type: 'codex-cli', visibleTextPolicy: 'forbidden' };
  const valid = inspectRunPreflight({ segments: [{ id: 'clip_01', prompt: h3Prompt(1) }], workflow, config, imageCount: 1, generator });
  assert.equal(valid.ok, true);
  assert.equal(valid.checks.find((check) => check.id === 'subtitle-policy').ok, true);
  const invalidPrompt = h3Prompt(1).replace('No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing. ', '');
  const invalid = inspectRunPreflight({ segments: [{ id: 'clip_01', prompt: invalidPrompt }], workflow, config, imageCount: 1, generator });
  assert.equal(invalid.ok, false);
  assert.match(invalid.checks.find((check) => check.id === 'subtitle-policy').detail, /正式な字幕禁止文なし/);
});

test('ComfyUI execution error formatting remains actionable', () => {
  const message = formatComfyExecutionError({ node_id: '42', node_type: 'H3ReferenceVideo', exception_type: 'TypeError', exception_message: 'bad input' }, 'prompt-1');
  assert.match(message, /node 42/);
  assert.match(message, /H3ReferenceVideo/);
  assert.match(extractHistoryExecutionError({ status: { messages: [['execution_error', { node_id: '7', node_type: 'LoadImage', exception_message: 'missing' }]] } }, 'p1'), /node 7/);
});
