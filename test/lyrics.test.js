import test from 'node:test';
import assert from 'node:assert/strict';
import { applyLyricsToProject, parseSrt, splitSrtCues } from '../public/lyrics.js';

test('SRT cues parse and split across clip boundaries with local timing', () => {
  const cues = parseSrt('1\n00:00:14,500 --> 00:00:15,500\n境界の歌\n\n2\n00:00:16,000 --> 00:00:17,000\n次の歌');
  assert.equal(cues.length, 2);
  const split = splitSrtCues(cues, 15, 30);
  assert.equal(split.length, 2);
  assert.equal(split[0][0].localStart, 14.5);
  assert.equal(split[0][0].localEnd, 15);
  assert.equal(split[1][0].localStart, 0);
  assert.equal(split[1][0].localEnd, 0.5);
  assert.equal(split[1][1].text, '次の歌');
});

test('lyric project decoration permits only SRT text and forbids text in empty scenes', () => {
  const project = {
    totalDurationSeconds: 30,
    segments: [
      { id: 'clip_01', prompt: 'subject_definitions:\nsummary:\nretention_analysis:\ndetailed_description:\noverall_soundscape:\nnon_diegetic_music:' },
      { id: 'clip_02', prompt: 'subject_definitions:\nsummary:\nretention_analysis:\ndetailed_description:\noverall_soundscape:\nnon_diegetic_music:' },
    ],
  };
  const decorated = applyLyricsToProject(project, parseSrt('1\n00:00:01,000 --> 00:00:02,000\n歌詞だけ'), 15, 'turquoise', 2);
  assert.equal(decorated.segments[0].subtitlePolicy, 'lyric');
  assert.match(decorated.segments[0].prompt, /歌詞だけ/);
  assert.match(decorated.segments[0].prompt, /Do not add any other subtitles/);
  assert.equal(decorated.segments[1].subtitlePolicy, 'forbidden');
  assert.match(decorated.segments[1].prompt, /No visible subtitles/);
  assert.match(decorated.segments[0].prompt, /<Audio 1>/);
});
