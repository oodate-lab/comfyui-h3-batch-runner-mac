import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = path.join(os.tmpdir(), 'comfyui-h3-anime-runner');
const promptSkillDirs = {
  anime: path.join(rootDir, 'skills', 'japanese-anime-ref2va-prompter'),
  mv: path.join(rootDir, 'skills', 'japanese-mv-ref2v-prompter'),
};
const promptSchemaPaths = {
  anime: path.join(promptSkillDirs.anime, 'references', 'output-schema.json'),
  mv: path.join(promptSkillDirs.mv, 'references', 'output-schema.json'),
};
await fsp.mkdir(runtimeDir, { recursive: true });
const logPath = path.join(runtimeDir, 'runner.log');

function writeLog(level, message, details = {}) {
  const row = JSON.stringify({ time: new Date().toISOString(), level, message, ...details });
  fs.appendFileSync(logPath, `${row}\n`, 'utf8');
}

const state = { running: false, cancelling: false, current: null, completed: [], errors: [], startedAt: null };
const sseClients = new Set();

function snapshot() {
  return { running: state.running, cancelling: state.cancelling, current: state.current, completed: state.completed, errors: state.errors, startedAt: state.startedAt };
}

function emit(type, data = {}) {
  const payload = `event: ${type}\ndata: ${JSON.stringify({ ...data, state: snapshot() })}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function normalizeHttpUrl(value, fallback) {
  const parsed = new URL(value || fallback);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('URLはhttpまたはhttpsを使用してください。');
  return parsed.toString().replace(/\/$/, '');
}

function normalizeComfyUrl(value) {
  return normalizeHttpUrl(value, 'http://127.0.0.1:8188');
}

function clone(value) {
  return structuredClone(value);
}

function nodeAt(workflow, nodeId) {
  const node = workflow[String(nodeId)];
  if (!node || typeof node !== 'object' || !node.inputs) throw new Error(`Node ${nodeId} was not found in the API workflow.`);
  return node;
}

function isWorkflowLink(workflow, value) {
  return Array.isArray(value) && value.length === 2 && workflow[String(value[0])] && Number.isInteger(Number(value[1]));
}

function setInput(workflow, mapping, value, required = false) {
  if (!mapping?.nodeId || !mapping?.inputKey) {
    if (required) throw new Error('A required node mapping is missing.');
    return;
  }
  const node = nodeAt(workflow, mapping.nodeId);
  if (!(mapping.inputKey in node.inputs)) throw new Error(`Input ${mapping.inputKey} does not exist on node ${mapping.nodeId}.`);
  if (isWorkflowLink(workflow, node.inputs[mapping.inputKey])) {
    const [upstreamId, outputIndex] = node.inputs[mapping.inputKey];
    throw new Error(`Node ${mapping.nodeId}.${mapping.inputKey} is a connection from node ${upstreamId} output ${outputIndex}, not an editable text field.`);
  }
  const currentValue = node.inputs[mapping.inputKey];
  const currentType = currentValue === null ? 'null' : typeof currentValue;
  const nextType = value === null ? 'null' : typeof value;
  if (currentValue !== null && value !== null && currentType !== nextType) throw new Error(`Node ${mapping.nodeId}.${mapping.inputKey} is ${currentType}, but the controller tried to assign ${nextType}.`);
  node.inputs[mapping.inputKey] = value;
}

export function patchWorkflow(baseWorkflow, segment, config, assetPaths) {
  const workflow = clone(baseWorkflow);
  setInput(workflow, config.prompt, segment.prompt, true);
  for (let i = 0; i < (config.images || []).length; i += 1) {
    const mapping = config.images[i];
    const uploadIndex = Number.isInteger(Number(mapping.uploadIndex)) ? Number(mapping.uploadIndex) : i;
    if (!assetPaths.images[uploadIndex]) throw new Error(`Picture ${i + 1} has no staged image file.`);
    setInput(workflow, mapping, assetPaths.images[uploadIndex], true);
  }
  if (config.audio?.nodeId && config.audio?.inputKey) {
    const audioIndex = Number.isInteger(Number(segment.index)) ? Number(segment.index) : Number(segment.number || 1) - 1;
    if (!assetPaths.audio?.[audioIndex]) throw new Error(`Clip ${segment.id || audioIndex + 1}に対応するMP3がありません。`);
    setInput(workflow, config.audio, assetPaths.audio[audioIndex], true);
  }
  if (config.filename?.nodeId && config.filename?.inputKey) {
    const safeTitle = String(segment.id).replace(/[^a-zA-Z0-9_-]/g, '_');
    setInput(workflow, config.filename, `${config.outputPrefix || 'h3_anime'}/${safeTitle}`);
  }
  for (const seedMap of config.seeds || []) {
    if (!seedMap.nodeId || !seedMap.inputKey) continue;
    setInput(workflow, seedMap, Number(config.baseSeed || 1) + Number(segment.index || 0));
  }
  return workflow;
}

async function stageReferenceImages(comfyInputDir, runId, imageFiles) {
  const subfolder = `h3_anime_${runId}`;
  const destination = path.join(comfyInputDir, subfolder);
  await fsp.mkdir(destination, { recursive: true });
  const images = [];
  for (let i = 0; i < imageFiles.length; i += 1) {
    const file = imageFiles[i];
    const safeName = path.basename(file.name).replace(/[^\p{L}\p{N}._-]+/gu, '_');
    const finalName = `ref${i + 1}_${safeName}`;
    await fsp.writeFile(path.join(destination, finalName), Buffer.from(await file.arrayBuffer()));
    images.push(`${subfolder}/${finalName}`);
  }
  return { subfolder, destination, images };
}

async function stageAudioFiles(comfyInputDir, runId, audioFiles) {
  const subfolder = `h3_anime_${runId}`;
  const destination = path.join(comfyInputDir, subfolder);
  await fsp.mkdir(destination, { recursive: true });
  const audio = [];
  for (let index = 0; index < audioFiles.length; index += 1) {
    const file = audioFiles[index];
    const extension = path.extname(file.name || '').toLowerCase().replace(/[^.a-z0-9]/g, '') || '.mp3';
    const finalName = `audio${String(index + 1).padStart(3, '0')}${extension}`;
    await fsp.writeFile(path.join(destination, finalName), Buffer.from(await file.arrayBuffer()));
    audio.push(`${subfolder}/${finalName}`);
  }
  return audio;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 1200)}`);
  return data;
}

export function extractJsonObject(value) {
  const text = String(value || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI応答にJSONオブジェクトがありません。');
  try { return JSON.parse(text.slice(start, end + 1)); } catch (error) { throw new Error(`AI応答のJSONを解析できません: ${error.message}`); }
}

const PROMPT_SECTIONS = ['subject_definitions:', 'summary:', 'retention_analysis:', 'detailed_description:', 'overall_soundscape:', 'non_diegetic_music:'];
const VISUAL_TEXT_EXCLUSION = 'No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.';

function promptHasOrderedSections(prompt) {
  let cursor = -1;
  for (const section of PROMPT_SECTIONS) {
    const next = prompt.toLowerCase().indexOf(section, cursor + 1);
    if (next < 0) return false;
    cursor = next;
  }
  return true;
}

function timeLabel(seconds) {
  const value = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(value % 60).padStart(2, '0')}`;
}

function hasSubtitleExclusion(prompt) {
  return [
    /\bno\s+(?:visible\s+)?(?:subtitles?|captions?)\b/i,
    /\b(?:subtitles?|captions?)\b[^.\n]{0,100}\b(?:prohibited|forbidden|excluded|absent|disabled|not allowed|must not|should not|do not|never|cannot)\b/i,
    /\b(?:do not|never|must not|should not)\s+(?:show|display|render|add|include|overlay|generate|present)\b[^.\n]{0,100}\b(?:subtitles?|captions?)\b/i,
    /\b(?:without|exclude|omit|avoid|disable)\b[^.\n]{0,100}\b(?:subtitles?|captions?)\b/i,
    /\b(?:subtitle|caption)-free\b/i,
    /(?:字幕|キャプション)[^。\n]{0,40}(?:禁止|表示しない|出さない|なし)/,
  ].some((pattern) => pattern.test(prompt));
}

function requestsVisibleSubtitles(prompt) {
  return [
    /(?:^|[.\n]\s*)(?:please\s+)?(?:show|display|render|add|include|overlay|generate|present)\b[^.\n]{0,100}\b(?:subtitles?|captions?)\b/im,
    /(?:^|[.\n]\s*)(?:subtitles?|captions?)\b[^.\n]{0,100}\b(?:should|must|will)\s+(?:show|display|render|appear|overlay)\b/im,
    /(?:^|[。\n]\s*)(?:字幕|キャプション)[^。\n]{0,40}(?:を)?(?:表示する|追加する|描画する|出す|入れる)/m,
  ].some((pattern) => pattern.test(prompt));
}

function ensureVisualTextExclusion(prompt, id) {
  if (requestsVisibleSubtitles(prompt)) throw new Error(`${id}に字幕を表示する指示が混入しています。`);
  if (prompt.includes(VISUAL_TEXT_EXCLUSION)) return prompt;
  const marker = 'detailed_description:';
  const markerIndex = prompt.toLowerCase().indexOf(marker);
  if (markerIndex < 0) return prompt;
  const insertAt = markerIndex + marker.length;
  return `${prompt.slice(0, insertAt)}\n${VISUAL_TEXT_EXCLUSION}\n${prompt.slice(insertAt).replace(/^\s*/, '')}`;
}

function normalizeJapaneseDialogueTags(prompt) {
  return prompt.replace(/<d>\s*\[(?:Japanese|JP|JA|日本語)\]\s*:?\s*/gi, '<d>[Japanese] ');
}

function ensurePictureReferences(prompt, referenceCount) {
  const missing = [];
  for (let picture = 1; picture <= referenceCount; picture += 1) {
    if (!new RegExp(`<Picture\\s+${picture}>`, 'i').test(prompt)) missing.push(picture);
  }
  if (!missing.length) return { prompt, missing };
  const marker = 'subject_definitions:';
  const markerIndex = prompt.toLowerCase().indexOf(marker);
  if (markerIndex < 0) return { prompt, missing };
  const insertAt = markerIndex + marker.length;
  const additions = missing.map((picture) => `<Picture ${picture}> is an ordered visual reference. Preserve its visible character, object, or environment design faithfully wherever it appears.`).join('\n');
  return {
    prompt: `${prompt.slice(0, insertAt)}\n${additions}\n${prompt.slice(insertAt).replace(/^\s*/, '')}`,
    missing,
  };
}

export function validateAnimeProject(raw, request) {
  const mode = request.mode === 'mv' ? 'mv' : 'anime';
  const totalDurationSeconds = Number(request.totalDurationSeconds);
  const segmentSeconds = Number(request.segmentSeconds);
  const referenceCount = Number(request.referenceCount);
  if (!Number.isFinite(totalDurationSeconds) || totalDurationSeconds <= 0 || totalDurationSeconds > 300) throw new Error('全体秒数は1～300秒で指定してください。');
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0 || segmentSeconds > 15) throw new Error('1クリップ秒数は15秒以下で指定してください。');
  if (!Number.isInteger(referenceCount) || referenceCount < 1 || referenceCount > 9) throw new Error('参照画像は1～9枚必要です。');
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments)) throw new Error('AI応答にsegments配列がありません。');
  const expectedCount = Math.ceil(totalDurationSeconds / segmentSeconds);
  if (raw.segments.length !== expectedCount) throw new Error(`AIが${raw.segments.length}クリップを返しましたが、必要数は${expectedCount}です。`);
  if (!Array.isArray(raw.referenceAnalysis) || raw.referenceAnalysis.length !== referenceCount) throw new Error(`AIの参照画像分析が${raw.referenceAnalysis?.length || 0}件です。必要数は${referenceCount}件です。`);

  const validationWarnings = [];
  const autoRepairs = [];
  const segments = raw.segments.map((entry, index) => {
    const startSeconds = index * segmentSeconds;
    const durationSeconds = Math.min(segmentSeconds, totalDurationSeconds - startSeconds);
    const id = `clip_${String(index + 1).padStart(2, '0')}`;
    let prompt = String(entry?.prompt || '').trim();
    if (!promptHasOrderedSections(prompt)) throw new Error(`${id}のプロンプトにH3の6セクションが揃っていません。`);
    if (mode === 'anime' && /<Audio\s+\d+>/i.test(prompt)) throw new Error(`${id}に外部Audio参照が混入しています。`);
    const normalizedPrompt = normalizeJapaneseDialogueTags(prompt);
    if (normalizedPrompt !== prompt) autoRepairs.push(`${id}: 日本語台詞タグを標準形式へ変換しました。`);
    prompt = normalizedPrompt;
    const subtitleSafePrompt = ensureVisualTextExclusion(prompt, id);
    if (subtitleSafePrompt !== prompt) autoRepairs.push(`${id}: 字幕禁止文を自動補完しました。`);
    prompt = subtitleSafePrompt;
    const pictureRepair = ensurePictureReferences(prompt, referenceCount);
    if (pictureRepair.missing.length) autoRepairs.push(`${id}: ${pictureRepair.missing.map((picture) => `<Picture ${picture}>`).join('、')}参照を自動補完しました。`);
    prompt = pictureRepair.prompt;
    if (mode === 'anime' && !/<d>\[Japanese\][\s\S]+?<\/d>/i.test(prompt)) validationWarnings.push(`${id}: 日本語台詞タグがありません。台詞なしのクリップとして続行します。`);
    return {
      id, number: index + 1, startSeconds, durationSeconds,
      sourceRange: `${timeLabel(startSeconds)}–${timeLabel(startSeconds + durationSeconds)}`,
      synopsis: String(entry.synopsis || `クリップ${index + 1}`),
      dialoguePreview: String(entry.dialoguePreview || '日本語音声'),
      subtitlePolicy: 'forbidden',
      prompt,
    };
  });
  return {
    mode,
    title: String(raw.title || request.title || (mode === 'mv' ? 'Japanese Music Video Project' : 'Japanese Anime Project')).trim(),
    totalDurationSeconds, segmentSeconds,
    referenceAnalysis: raw.referenceAnalysis,
    voiceCast: Array.isArray(raw.voiceCast) ? raw.voiceCast : [],
    continuityBible: String(raw.continuityBible || ''),
    validationWarnings,
    autoRepairs,
    generator: {
      type: 'codex-cli',
      mode,
      validatedAt: new Date().toISOString(),
      visibleTextPolicy: mode === 'mv' ? 'web-srt' : 'forbidden',
    },
    segments,
  };
}

function resultCheck(id, label, ok, detail) {
  return { id, label, ok: Boolean(ok), detail: String(detail || '') };
}

export function inspectRunPreflight({ segments, workflow, config, imageCount, audioCount = 0, generator }) {
  const checks = [];
  const selected = Array.isArray(segments) ? segments : [];
  const mode = generator?.mode === 'mv' ? 'mv' : 'anime';
  const expectedTextPolicy = mode === 'mv' ? 'web-srt' : 'forbidden';
  checks.push(resultCheck('codex-cli', 'Codex CLI生成・モード検証', generator?.type === 'codex-cli' && generator?.visibleTextPolicy === expectedTextPolicy,
    generator?.type === 'codex-cli' ? `${mode === 'mv' ? 'MV' : 'アニメ'}用参照プロンプトと文字ポリシーを確認` : 'このRunnerのCodex CLIで生成したプロジェクトではありません。'));
  checks.push(resultCheck('segments', '生成クリップ', selected.length > 0, selected.length ? `${selected.length}件を選択` : 'クリップが選択されていません'));

  const sectionFailures = selected.filter((segment) => !promptHasOrderedSections(String(segment?.prompt || ''))).map((segment) => segment?.id || 'unknown');
  checks.push(resultCheck('sections', 'H3六セクション', sectionFailures.length === 0 && selected.length > 0, sectionFailures.length ? `不足: ${sectionFailures.join(', ')}` : '全クリップで順序を確認'));

  const externalAudio = Number(audioCount) > 0;
  const audioFailures = externalAudio
    ? selected.filter((segment) => !segment?.audioReference || !/<Audio\s+1>/i.test(String(segment?.prompt || ''))).map((segment) => segment?.id || 'unknown')
    : selected.filter((segment) => /<Audio\s+\d+>/i.test(String(segment?.prompt || ''))).map((segment) => segment?.id || 'unknown');
  checks.push(resultCheck('audio-reference', externalAudio ? 'MP3参照と<Audio 1>対応' : 'H3ネイティブ音声', audioFailures.length === 0,
    audioFailures.length ? (externalAudio ? `MP3参照未反映: ${audioFailures.join(', ')}` : `外部Audio参照: ${audioFailures.join(', ')}`) : externalAudio ? `MP3 ${audioCount}件を連番対応` : 'MP3・外部Audio参照なし'));

  const visibleTextFailures = selected.filter((segment) => requestsVisibleSubtitles(String(segment?.prompt || ''))).map((segment) => segment?.id || 'unknown');
  const noLyricFailures = selected.filter((segment) => !segment?.lyricCues?.length && !String(segment?.prompt || '').includes(VISUAL_TEXT_EXCLUSION)).map((segment) => segment?.id || 'unknown');
  const lyricFailures = selected.filter((segment) => segment?.lyricCues?.length && !/Lyric motion graphics/i.test(String(segment?.prompt || ''))).map((segment) => segment?.id || 'unknown');
  const subtitleOk = visibleTextFailures.length === 0 && noLyricFailures.length === 0 && lyricFailures.length === 0 && selected.length > 0;
  const subtitleDetail = visibleTextFailures.length
    ? `字幕表示指示あり: ${visibleTextFailures.join(', ')}`
    : noLyricFailures.length ? `正式な字幕禁止文なし: ${noLyricFailures.join(', ')}`
      : lyricFailures.length ? `リリックモーション未反映: ${lyricFailures.join(', ')}` : 'SRTあり区間は歌詞のみ、歌詞なし区間は字幕禁止';
  checks.push(resultCheck('subtitle-policy', '字幕・リリックポリシー', subtitleOk, subtitleDetail));

  const combined = selected.map((segment) => String(segment?.prompt || '')).join('\n');
  const missingPictures = [];
  for (let picture = 1; picture <= Number(imageCount || 0); picture += 1) {
    if (!combined.includes(`<Picture ${picture}>`)) missingPictures.push(picture);
  }
  checks.push(resultCheck('picture-references', '参照画像ラベル', Number(imageCount) >= 1 && Number(imageCount) <= 9 && missingPictures.length === 0,
    missingPictures.length ? `未使用: ${missingPictures.map((value) => `<Picture ${value}>`).join(', ')}` : `Picture 1～${imageCount}を確認`));

  let workflowError = '';
  try {
    if (!workflow || typeof workflow !== 'object') throw new Error('APIワークフローがありません。');
    if (!config?.prompt?.nodeId || !config?.prompt?.inputKey) throw new Error('プロンプト入力が未割り当てです。');
    if ((config.images || []).length !== Number(imageCount)) throw new Error(`画像マッピング${config.images?.length || 0}件 / 実画像${imageCount}件です。`);
    const stagedImages = Array.from({ length: Number(imageCount) }, (_, index) => `preflight/ref${index + 1}.png`);
    const stagedAudio = Array.from({ length: Number(audioCount || 0) }, (_, index) => `preflight/audio${index + 1}.mp3`);
    if (Number(audioCount || 0) > 0 && (!config.audio?.nodeId || !config.audio?.inputKey)) throw new Error('MP3音声ノードの割り当てがありません。');
    if (selected.length) patchWorkflow(workflow, { ...selected[0], index: Number(selected[0].number || 1) - 1 }, config, { images: stagedImages, audio: stagedAudio });
  } catch (error) {
    workflowError = error.message;
  }
  checks.push(resultCheck('workflow', 'ワークフロー入力型と画像接続', !workflowError, workflowError || `画像${imageCount}枚を自動接続可能`));

  const seedMappings = config?.seeds || [];
  const invalidSeeds = seedMappings.filter((mapping) => !mapping?.nodeId || !mapping?.inputKey);
  const numericSeed = !seedMappings.length || Number.isFinite(Number(config?.baseSeed));
  checks.push(resultCheck('seed', 'Seed設定', invalidSeeds.length === 0 && numericSeed,
    invalidSeeds.length ? '未完成のSeed割り当てがあります。' : !seedMappings.length ? 'Seedノードは未使用' : numericSeed ? `基準Seed ${Number(config.baseSeed)}` : '基準Seedが数値ではありません。'));

  return { ok: checks.every((check) => check.ok), checks };
}

function throwFailedPreflight(preflight) {
  if (preflight.ok) return;
  const failed = preflight.checks.filter((check) => !check.ok).map((check) => `${check.label}: ${check.detail}`);
  throw new Error(`生成前チェックに失敗しました。${failed.join(' / ')}`);
}

async function loadPromptSkill(mode = 'anime') {
  const promptSkillDir = promptSkillDirs[mode === 'mv' ? 'mv' : 'anime'];
  const [skill, schema] = await Promise.all([
    fsp.readFile(path.join(promptSkillDir, 'SKILL.md'), 'utf8'),
    fsp.readFile(path.join(promptSkillDir, 'references', 'output-schema.md'), 'utf8'),
  ]);
  return `${skill}\n\n${schema}`;
}

function validateCodexCommand(value) {
  let command = String(value || 'codex').trim();
  if (command.length >= 2 && command.startsWith('"') && command.endsWith('"')) command = command.slice(1, -1).trim();
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) throw new Error('Codex CLIコマンドが不正です。');
  return command;
}

export function buildCodexSearchCandidates(value, env = process.env, platform = process.platform) {
  const command = validateCodexCommand(value);
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  if (pathApi.isAbsolute(command) || command.includes('/') || command.includes('\\')) return [command];
  const pathValue = env.PATH || env.Path || '';
  const pathDirs = pathValue.split(pathApi.delimiter).map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (platform === 'win32') {
    for (const npmDir of [env.APPDATA && pathApi.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && pathApi.join(env.LOCALAPPDATA, 'npm')].filter(Boolean)) {
      if (!pathDirs.some((entry) => entry.toLowerCase() === npmDir.toLowerCase())) pathDirs.push(npmDir);
    }
  } else if (platform === 'darwin') {
    const macDirs = [
      '/opt/homebrew/bin',
      '/usr/local/bin',
      env.HOME && pathApi.join(env.HOME, '.npm-global', 'bin'),
      env.HOME && pathApi.join(env.HOME, '.local', 'bin'),
      env.npm_config_prefix && pathApi.join(env.npm_config_prefix, 'bin'),
    ].filter(Boolean);
    for (const directory of macDirs) {
      if (!pathDirs.includes(directory)) pathDirs.push(directory);
    }
  }
  const hasExtension = Boolean(pathApi.extname(command));
  const names = platform === 'win32' && !hasExtension ? [`${command}.cmd`, `${command}.exe`, `${command}.bat`, command] : [command];
  return [...new Set(pathDirs.flatMap((directory) => names.map((name) => pathApi.join(directory, name))))];
}

async function resolveCodexCommand(value) {
  const requested = validateCodexCommand(value);
  for (const candidate of buildCodexSearchCandidates(requested)) {
    try {
      await fsp.access(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
      return candidate;
    } catch {}
  }
  if (process.platform === 'darwin') {
    throw new Error(
      'Codex CLIが見つかりません。ターミナルで「npm install -g @openai/codex」を実行し、続けて「codex」を起動してChatGPTへログインしてください。' +
      'インストール済みの場合は「which codex」で表示されたフルパスをWEB画面へ入力し、Runnerを再起動してください。',
    );
  }
  throw new Error(
    'Codex CLIが見つかりません。「npm install -g @openai/codex」を実行し、続けて「codex」を起動してChatGPTへログインしてください。' +
    'Windowsでは「where.exe codex」、macOS/Linuxでは「which codex」で表示されたフルパスをWEB画面へ入力してください。',
  );
}

function validateCodexModel(value) {
  const model = String(value || '').trim();
  if (model && (!/^[A-Za-z0-9._:/-]+$/.test(model) || model.length > 200)) throw new Error('Codexモデル名が不正です。');
  return model;
}

function quoteWindowsArg(value) {
  const text = String(value);
  return `"${text.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
}

function spawnPortable(command, args, options) {
  if (process.platform !== 'win32') return spawn(command, args, options);
  if (/\.exe$/i.test(command)) return spawn(command, args, options);
  const commandLine = [command, ...args].map(quoteWindowsArg).join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `chcp 65001>nul & ${commandLine}`], options);
}

async function runCommand(command, args, { cwd, input = '', timeoutMs = 20 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnPortable(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    const maxBytes = 4 * 1024 * 1024;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill();
      settled = true;
      reject(new Error(`Codex CLIが${Math.round(timeoutMs / 60_000)}分以内に完了しませんでした。`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Codex CLIを起動できません: ${error.message}`));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(stdout).toString('utf8').trim();
      const progress = Buffer.concat(stderr).toString('utf8').trim();
      if (code !== 0) {
        const detail = progress || output || `終了コード ${code}${signal ? ` (${signal})` : ''}`;
        reject(new Error(`Codex CLI実行エラー: ${detail.slice(-3000)}`));
      } else resolve({ stdout: output, stderr: progress, code });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export function buildCodexExecArgs({ model = '', schemaPath, outputPath, imagePaths = [] }) {
  const args = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--output-schema', schemaPath, '-o', outputPath];
  if (model) args.push('--model', model);
  for (const imagePath of imagePaths) args.push('--image', imagePath);
  args.push('-');
  return args;
}

async function stageCodexImages(jobDir, imageFiles) {
  const imagePaths = [];
  for (let index = 0; index < imageFiles.length; index += 1) {
    const originalExtension = path.extname(imageFiles[index].name || '').toLowerCase();
    const extension = /^\.(png|jpe?g|webp|bmp|gif)$/.test(originalExtension) ? originalExtension : '.png';
    const imagePath = path.join(jobDir, `picture-${index + 1}${extension}`);
    await fsp.writeFile(imagePath, Buffer.from(await imageFiles[index].arrayBuffer()));
    imagePaths.push(imagePath);
  }
  return imagePaths;
}

function buildCodexPrompt(systemPrompt, request, imagePaths) {
  const pictureMap = imagePaths.map((imagePath, index) => `<Picture ${index + 1}> = attached image ${path.basename(imagePath)}`).join('\n');
  return `${systemPrompt}\n\n# Current task\nCreate the final JSON project from the input below. Inspect every attached image carefully. Use the exact attachment order shown in the picture map. Return only the JSON object required by the supplied schema.\n\n## Picture map\n${pictureMap}\n\n## Project input\n${JSON.stringify(request, null, 2)}`;
}

export async function testCodexCli(payload = {}) {
  const command = await resolveCodexCommand(payload.codexCommand);
  const result = await runCommand(command, ['--version'], { cwd: rootDir, timeoutMs: 15_000 });
  return { version: result.stdout || result.stderr || 'Codex CLI detected', command };
}

async function callPromptCodex(payload, imageFiles) {
  const command = await resolveCodexCommand(payload.codexCommand);
  const model = validateCodexModel(payload.codexModel);
  const timeoutMinutes = Math.min(60, Math.max(1, Number(payload.codexTimeoutMinutes) || 20));
  const mode = payload.mode === 'mv' ? 'mv' : 'anime';
  const systemPrompt = await loadPromptSkill(mode);
  const request = {
    mode,
    title: String(payload.title || '').trim(),
    roughStory: String(payload.roughStory || '').trim(),
    totalDurationSeconds: Number(payload.totalDurationSeconds),
    segmentSeconds: Number(payload.segmentSeconds),
    animeDirection: String(payload.animeDirection || 'polished Japanese TV anime'),
    dialogueDensity: String(payload.dialogueDensity || 'standard'),
    voiceDirection: String(payload.voiceDirection || '').trim(),
    referenceCount: imageFiles.length,
    lyricCues: mode === 'mv' ? parsedValue(payload.lyricCuesJson || '[]', 'SRT歌詞キュー') : [],
    audioFileNames: mode === 'mv' ? parsedValue(payload.audioFileNamesJson || '[]', '音声ファイル一覧') : [],
    hardConstraints: mode === 'mv' ? [
      'Design a Japanese music video around the supplied story/concept and reference images.',
      'SRT lyric timing, exact lyric text, and lyric-motion design are added later by the web UI; do not invent or display any other text.',
      `Every segment prompt must contain this exact sentence inside detailed_description: ${VISUAL_TEXT_EXCLUSION}`,
      'When matching audio files are listed, leave room for the exact per-clip <Audio 1> reference that the web UI inserts later.',
      'Do not generate spoken character dialogue unless the story explicitly requires it.',
      'Use the requested duration and exact segment count.',
    ] : [
      'No external audio, MP3, SRT, subtitles, captions, lyric motion, visible text, or voice cloning.',
      `Every segment prompt must contain this exact sentence inside detailed_description: ${VISUAL_TEXT_EXCLUSION}`,
      'Generate original natural Japanese dialogue and character-matched professional Japanese animation voice performances.',
      'Use the requested duration and exact segment count.',
    ],
  };
  if (!request.roughStory) throw new Error('大まかなストーリーを入力してください。');
  const jobDir = await fsp.mkdtemp(path.join(runtimeDir, 'codex-job-'));
  try {
    const imagePaths = await stageCodexImages(jobDir, imageFiles);
    const outputPath = path.join(jobDir, `${mode}-project.json`);
    const args = buildCodexExecArgs({ model, schemaPath: promptSchemaPaths[mode], outputPath, imagePaths });
    const prompt = buildCodexPrompt(systemPrompt, request, imagePaths);
    const result = await runCommand(command, args, { cwd: jobDir, input: prompt, timeoutMs: timeoutMinutes * 60_000 });
    let output = '';
    try { output = await fsp.readFile(outputPath, 'utf8'); } catch { output = result.stdout; }
    const raw = extractJsonObject(output);
    return validateAnimeProject(raw, request);
  } finally {
    await fsp.rm(jobDir, { recursive: true, force: true });
  }
}

export function formatComfyExecutionError(data = {}, promptId = '') {
  const nodeId = data.node_id ?? data.node ?? 'unknown';
  const nodeType = data.node_type ?? data.class_type ?? 'unknown';
  const exceptionType = data.exception_type ?? 'ExecutionError';
  const exceptionMessage = data.exception_message ?? data.message ?? 'Unknown ComfyUI execution error.';
  return `ComfyUI node ${nodeId} (${nodeType}) — ${exceptionType}: ${exceptionMessage}${promptId ? ` [prompt ${promptId}]` : ''}`;
}

export function extractHistoryExecutionError(item, promptId = '') {
  const messages = item?.status?.messages;
  if (Array.isArray(messages)) {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const entry = messages[index];
      if (Array.isArray(entry) && entry[0] === 'execution_error') return formatComfyExecutionError(entry[1] || {}, promptId);
    }
  }
  return `ComfyUI execution failed for ${promptId || 'an unknown prompt'}.`;
}

async function waitByHistory(comfyUrl, promptId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (state.cancelling) throw new Error('Cancelled by user.');
    const history = await fetchJson(`${comfyUrl}/history/${encodeURIComponent(promptId)}`);
    const item = history[promptId];
    if (item) {
      if (item.status?.status_str === 'error') throw new Error(extractHistoryExecutionError(item, promptId));
      if (item.status?.completed || item.outputs) return item;
    }
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }
  throw new Error(`Timed out waiting for prompt ${promptId}.`);
}

async function queueAndWait(comfyUrl, workflow, timeoutMs) {
  const clientId = crypto.randomUUID();
  const queued = await fetchJson(`${comfyUrl}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: clientId }) });
  if (!queued.prompt_id) throw new Error(`ComfyUI rejected the workflow: ${JSON.stringify(queued.node_errors || queued)}`);
  const promptId = queued.prompt_id;
  return { promptId, history: await waitByHistory(comfyUrl, promptId, timeoutMs) };
}

function parsedValue(value, label) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch (error) { throw new Error(`${label}を解析できません: ${error.message}`); }
}

export async function preflightRunPayload(payload, imageCount, { checkEnvironment = true } = {}) {
  const segments = parsedValue(payload.segmentsJson ?? payload.segments, 'クリップJSON');
  const workflow = parsedValue(payload.workflowJson ?? payload.workflow, 'ワークフローJSON');
  const config = parsedValue(payload.mappingJson ?? payload.mapping, 'ノード割り当てJSON');
  const generatorValue = payload.generatorJson ?? payload.generator;
  const generator = generatorValue ? parsedValue(generatorValue, 'Codex生成記録') : null;
  const result = inspectRunPreflight({ segments, workflow, config, imageCount, audioCount: Number(payload.audioCount || 0), generator });
  if (checkEnvironment) {
    let inputError = '';
    try {
      const inputDir = path.resolve(String(payload.comfyInputDir || ''));
      const stat = await fsp.stat(inputDir);
      if (!stat.isDirectory()) throw new Error('フォルダーではありません。');
    } catch (error) { inputError = error.message; }
    result.checks.push(resultCheck('input-folder', 'ComfyUI inputフォルダー', !inputError, inputError || '読み込み可能'));

    let connectionError = '';
    try { await fetchJson(`${normalizeComfyUrl(payload.comfyUrl)}/system_stats`); } catch (error) { connectionError = error.message; }
    result.checks.push(resultCheck('comfy-connection', 'ComfyUI接続', !connectionError, connectionError || 'system_stats応答あり'));
  }
  result.ok = result.checks.every((check) => check.ok);
  return { ...result, segments, workflow, config };
}

async function executeRun(payload, files) {
  state.running = true;
  state.cancelling = false;
  state.current = null;
  state.completed = [];
  state.errors = [];
  state.startedAt = new Date().toISOString();
  emit('run-started');
  const comfyUrl = normalizeComfyUrl(payload.comfyUrl);
  const comfyInputDir = path.resolve(payload.comfyInputDir);
  const runId = Date.now().toString(36);
  try {
    const stat = await fsp.stat(comfyInputDir);
    if (!stat.isDirectory()) throw new Error('The ComfyUI input path is not a directory.');
    await fetchJson(`${comfyUrl}/system_stats`);
    const segments = JSON.parse(payload.segmentsJson);
    const workflow = JSON.parse(payload.workflowJson);
    const config = JSON.parse(payload.mappingJson);
    if (!Array.isArray(segments) || !segments.length) throw new Error('No segments were selected.');
    if (!files.images?.length || files.images.length > 9) throw new Error('Reference images must contain Picture 1 through Picture 9.');
    const staged = await stageReferenceImages(comfyInputDir, runId, files.images);
    const stagedAudio = files.audio?.length ? await stageAudioFiles(comfyInputDir, runId, files.audio) : [];
    if ((config.images || []).length !== staged.images.length) throw new Error('Reference image mapping count does not match uploaded images.');
    if (stagedAudio.length && (!config.audio?.nodeId || !config.audio?.inputKey)) throw new Error('MP3音声ノードの割り当てがありません。');
    if (stagedAudio.length && stagedAudio.length < Math.max(...segments.map((segment) => Number(segment.number || 1)))) throw new Error('MP3参照ファイルがクリップ数に足りません。');
    for (let i = 0; i < segments.length; i += 1) {
      if (state.cancelling) throw new Error('Cancelled by user.');
      const segment = { ...segments[i], index: Number(segments[i].number || i + 1) - 1 };
      state.current = { index: i + 1, total: segments.length, id: segment.id, synopsis: segment.synopsis };
      emit('clip-started', { current: state.current });
      const result = await queueAndWait(comfyUrl, patchWorkflow(workflow, segment, config, { images: staged.images, audio: stagedAudio }), Number(config.timeoutMinutes || 90) * 60_000);
      state.completed.push({ id: segment.id, promptId: result.promptId });
      emit('clip-completed', { id: segment.id, promptId: result.promptId });
    }
    emit('run-completed');
  } catch (error) {
    writeLog('error', error.message, { runId, clip: state.current?.id || null, stack: error.stack });
    state.errors.push({ clip: state.current?.id || null, message: error.message });
    emit(state.cancelling ? 'run-cancelled' : 'run-error', { message: error.message });
  } finally {
    state.running = false;
    state.current = null;
    emit('state');
  }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function toWebRequest(req) {
  const method = req.method || 'GET';
  const options = { method, headers: req.headers };
  if (!['GET', 'HEAD'].includes(method)) {
    options.body = Readable.toWeb(req);
    options.duplex = 'half';
  }
  return new Request(`http://${req.headers.host || '127.0.0.1'}${req.url}`, options);
}

function formFields(form) {
  const output = {};
  for (const [key, value] of form.entries()) {
    if (typeof value === 'string') output[key] = value;
  }
  return output;
}

function formImages(form) {
  const images = form.getAll('images').filter((value) => value && typeof value.arrayBuffer === 'function');
  if (images.length > 9) throw new Error('参照画像は最大9枚です。');
  for (const image of images) {
    if (image.size > 25 * 1024 * 1024) throw new Error(`${image.name}は25MBを超えています。`);
    if (image.type && !image.type.startsWith('image/')) throw new Error(`${image.name}は画像ファイルではありません。`);
  }
  return images;
}

function formAudio(form) {
  const audio = form.getAll('audio').filter((value) => value && typeof value.arrayBuffer === 'function');
  if (audio.length > 300) throw new Error('音声ファイルは最大300件です。');
  for (const file of audio) {
    if (file.size > 200 * 1024 * 1024) throw new Error(`${file.name}は200MBを超えています。`);
    if (file.type && !file.type.startsWith('audio/')) throw new Error(`${file.name}は音声ファイルではありません。`);
  }
  return audio;
}

const STATIC_FILES = new Map([
  ['/', [path.join(rootDir, 'public', 'index.html'), 'text/html; charset=utf-8']],
  ['/index.html', [path.join(rootDir, 'public', 'index.html'), 'text/html; charset=utf-8']],
  ['/app.js', [path.join(rootDir, 'public', 'app.js'), 'text/javascript; charset=utf-8']],
  ['/workflow-inspector.js', [path.join(rootDir, 'public', 'workflow-inspector.js'), 'text/javascript; charset=utf-8']],
  ['/lyrics.js', [path.join(rootDir, 'public', 'lyrics.js'), 'text/javascript; charset=utf-8']],
  ['/styles.css', [path.join(rootDir, 'public', 'styles.css'), 'text/css; charset=utf-8']],
  ['/PROMPT_SKILL.md', [path.join(promptSkillDirs.anime, 'SKILL.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SKILL_ANIME.md', [path.join(promptSkillDirs.anime, 'SKILL.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SKILL_MV.md', [path.join(promptSkillDirs.mv, 'SKILL.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SCHEMA.md', [path.join(promptSkillDirs.anime, 'references', 'output-schema.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SCHEMA_ANIME.md', [path.join(promptSkillDirs.anime, 'references', 'output-schema.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SCHEMA_MV.md', [path.join(promptSkillDirs.mv, 'references', 'output-schema.md'), 'text/markdown; charset=utf-8']],
  ['/PROMPT_SCHEMA.json', [promptSchemaPaths.anime, 'application/json; charset=utf-8']],
  ['/MAC_SETUP.md', [path.join(rootDir, 'MAC_SETUP.md'), 'text/markdown; charset=utf-8']],
]);

async function serveStatic(pathname, res) {
  const item = STATIC_FILES.get(pathname);
  if (!item) return false;
  const body = await fsp.readFile(item[0]);
  res.writeHead(200, { 'content-type': item[1], 'content-length': body.length, 'cache-control': 'no-store' });
  res.end(body);
  return true;
}

async function app(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    if (req.method === 'GET' && url.pathname === '/api/status') return sendJson(res, 200, snapshot());
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      try {
        const probe = path.join(runtimeDir, `probe-${process.pid}`);
        await fsp.writeFile(probe, 'ok');
        await fsp.unlink(probe);
        return sendJson(res, 200, { ok: true, node: process.version, platform: process.platform, arch: process.arch, runtimeWritable: true, logPath });
      } catch (error) {
        return sendJson(res, 500, { ok: false, node: process.version, platform: process.platform, arch: process.arch, runtimeWritable: false, logPath, error: error.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      sseClients.add(res);
      res.write(`event: state\ndata: ${JSON.stringify({ state: snapshot() })}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/test-connection') {
      const body = await toWebRequest(req).json();
      try {
        const stats = await fetchJson(`${normalizeComfyUrl(body.comfyUrl)}/system_stats`);
        return sendJson(res, 200, { ok: true, stats });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/test-codex') {
      const body = await toWebRequest(req).json();
      try {
        const detected = await testCodexCli(body);
        return sendJson(res, 200, { ok: true, ...detected });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && ['/api/generate-anime-project', '/api/generate-project'].includes(url.pathname)) {
      const form = await toWebRequest(req).formData();
      const fields = formFields(form);
      const images = formImages(form);
      try {
        if (!images.length) throw new Error('参照画像を1枚以上D&Dしてください。');
        const generatedProject = await callPromptCodex(fields, images);
        writeLog('info', 'Prompt project generated with Codex CLI.', { mode: fields.mode === 'mv' ? 'mv' : 'anime', model: fields.codexModel || 'configured-default', referenceCount: images.length, segments: generatedProject.segments.length });
        return sendJson(res, 200, { ok: true, project: generatedProject });
      } catch (error) {
        writeLog('error', 'Prompt generation failed.', { mode: fields.mode === 'mv' ? 'mv' : 'anime', error: error.message });
        return sendJson(res, 400, { ok: false, error: error.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/preflight-run') {
      const body = await toWebRequest(req).json();
      try {
        const preflight = await preflightRunPayload(body, Number(body.imageCount), { checkEnvironment: true });
        return sendJson(res, preflight.ok ? 200 : 400, { ok: preflight.ok, checks: preflight.checks });
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message, checks: [] });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/run') {
      if (state.running) return sendJson(res, 409, { ok: false, error: 'A batch is already running.' });
      const form = await toWebRequest(req).formData();
      const fields = formFields(form);
      const images = formImages(form);
      const audio = formAudio(form);
      if (!images.length) return sendJson(res, 400, { ok: false, error: '参照画像を1枚以上D&Dしてください。' });
      fields.audioCount = String(audio.length);
      try {
        const preflight = await preflightRunPayload(fields, images.length, { checkEnvironment: true });
        throwFailedPreflight(preflight);
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: error.message });
      }
      executeRun(fields, { images, audio });
      return sendJson(res, 202, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/api/cancel') {
      const body = await toWebRequest(req).json();
      state.cancelling = true;
      try { await fetch(`${normalizeComfyUrl(body.comfyUrl)}/interrupt`, { method: 'POST' }); } catch {}
      emit('cancelling');
      return sendJson(res, 200, { ok: true });
    }
    sendJson(res, 404, { ok: false, error: 'Not found.' });
  } catch (error) {
    writeLog('error', 'HTTP request failed.', { error: error.message, stack: error.stack });
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: error.message || 'Unexpected server error.' });
    else res.end();
  }
}

const port = Number(process.env.H3_RUNNER_PORT || 3030);
const isMainModule = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMainModule) {
  http.createServer(app).listen(port, '127.0.0.1', () => {
    writeLog('info', 'Server started.', { port, node: process.version });
    console.log(`ComfyUI H3 Dual Mode Director: http://127.0.0.1:${port}`);
    console.log(`Diagnostic log: ${logPath}`);
  });
}

export { app };
