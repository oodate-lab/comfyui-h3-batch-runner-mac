export const LYRIC_DESIGNS = [
  { id: 'turquoise', label: 'ターコイズ・ミニマル', description: 'clean bold white typography, turquoise and mint cyan accents, generous negative space, soft glow and smooth morphing' },
  { id: 'navy', label: 'ブルー・ネイビー', description: 'deep navy field, electric blue light, crisp white typography, restrained parallax and glass-like highlights' },
  { id: 'mincho', label: '氷の明朝', description: 'elegant white Mincho-style lyric typography, icy blue glow, slow floating motion and delicate particles' },
  { id: 'heat', label: '熱気・陽炎', description: 'warm white typography with amber and coral accents, heat-haze distortion and breathing scale pulses' },
  { id: 'stencil', label: 'レトロ・ステンシル', description: 'bold off-white stencil lettering, faded crimson and teal print texture, rhythmic slide and stamp motion' },
  { id: 'underwater', label: '海中・泡', description: 'soft white rounded typography drifting through turquoise underwater light, bubbles and gentle caustic ripples' },
  { id: 'reference', label: '参照画像準拠', description: 'match the typography palette, weight, spacing and graphic language visible in the supplied reference images' },
  { id: 'none', label: '字幕なし', description: '' },
];

const NO_TEXT = 'No visible subtitles, captions, speech bubbles, lyric typography, title cards, watermarks, logos, UI, or generated writing.';

function parseClock(value) {
  const match = String(value || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{3})$/);
  if (!match) return NaN;
  return (Number(match[1] || 0) * 3600) + (Number(match[2]) * 60) + Number(match[3]) + (Number(match[4]) / 1000);
}

export function parseSrt(text) {
  const blocks = String(text || '').replace(/\r/g, '').trim().split(/\n\s*\n/).filter(Boolean);
  const cues = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const timingIndex = lines.findIndex((line) => /-->/.test(line));
    if (timingIndex < 0) continue;
    const timing = lines[timingIndex].split('-->');
    const start = parseClock(timing[0]);
    const end = parseClock(timing[1]);
    const value = lines.slice(timingIndex + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !value) continue;
    cues.push({ index: cues.length + 1, start, end, text: value });
  }
  return cues;
}

export function splitSrtCues(cues, segmentSeconds, totalDurationSeconds) {
  const length = Number(segmentSeconds);
  const total = Number(totalDurationSeconds);
  const count = Math.ceil(total / length);
  return Array.from({ length: count }, (_, index) => {
    const segmentStart = index * length;
    const segmentEnd = Math.min(total, segmentStart + length);
    return (cues || []).filter((cue) => cue.end > segmentStart && cue.start < segmentEnd).map((cue) => ({
      ...cue,
      localStart: Math.max(cue.start, segmentStart) - segmentStart,
      localEnd: Math.min(cue.end, segmentEnd) - segmentStart,
    }));
  });
}

function hms(seconds) {
  const ms = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  const whole = Math.floor(ms / 1000);
  return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
}

function insertBeforeSection(prompt, section, content) {
  const lower = prompt.toLowerCase();
  const index = lower.indexOf(section.toLowerCase());
  if (index < 0) return `${prompt}\n${content}`;
  return `${prompt.slice(0, index)}${content}\n\n${prompt.slice(index)}`;
}

export function applyLyricsToProject(project, cues, segmentSeconds, designId = 'turquoise', audioCount = 0) {
  const design = LYRIC_DESIGNS.find((entry) => entry.id === designId) || LYRIC_DESIGNS[0];
  const split = splitSrtCues(cues, segmentSeconds, project.totalDurationSeconds);
  const segments = (project.segments || []).map((segment, index) => {
    const lyricCues = design.id === 'none' ? [] : (split[index] || []);
    let prompt = String(segment.prompt || '')
      .replace(NO_TEXT, '')
      .replace(/Lyric motion graphics \([^\n]+\):[\s\S]*?(?=\n\n(?:overall_soundscape:|non_diegetic_music:))/i, '')
      .replace(/<Audio 1> is the exact matching MP3 segment for this clip\.[^\n]*/gi, '')
      .replace(/\n{3,}/g, '\n\n').trim();
    if (lyricCues.length) {
      const timing = lyricCues.map((cue) => `At ${hms(cue.localStart)}–${hms(cue.localEnd)}, display only the exact Japanese lyric text 「${cue.text}」.`).join('\n');
      const motion = `Lyric motion graphics (${design.label}): ${design.description}.\n${timing}\nPreserve every Japanese character exactly. Do not translate, paraphrase, romanize, or add wording. Do not add any other subtitles, captions, titles, credits, logos, watermarks, UI, or generated writing.`;
      prompt = insertBeforeSection(prompt, 'overall_soundscape:', motion);
    } else {
      prompt = insertBeforeSection(prompt, 'overall_soundscape:', NO_TEXT);
    }
    const audioReference = audioCount > 0;
    if (audioReference) {
      prompt = insertBeforeSection(prompt, 'non_diegetic_music:', '<Audio 1> is the exact matching MP3 segment for this clip. Reuse it without replacement, extension, remix, or regeneration.');
    }
    return {
      ...segment,
      subtitlePolicy: lyricCues.length ? 'lyric' : 'forbidden',
      lyricMotionDesign: lyricCues.length ? design.id : 'none',
      lyricCues,
      audioReference,
      prompt,
    };
  });
  return { ...project, segments, lyricDesign: design.id, hasSrt: cues.length > 0, audioReference: audioCount > 0 };
}

export function naturalAudioSort(files) {
  return [...files].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}
