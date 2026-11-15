import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLanguage,
  countSyllables,
  analyzeNarration,
  timeWords,
  buildCaptionCues,
  planShots,
  planTimeline,
  DIRECTOR_STYLES
} from '../../src/engine/director.js';

const EN = 'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.';
const HI = 'गीज़ा का महान पिरामिड आज भी एक रहस्य है। यह लगभग पूरी तरह उत्तर दिशा की ओर बना है।';
const HINGLISH = 'Kya aap jaante hain? Giza ka pyramid aaj bhi ek raaz hai, lekin sach kuch aur hai.';

test('language detection: English, Hindi (Devanagari) and Hinglish', () => {
  assert.deepEqual(detectLanguage(EN), { language: 'en', script: 'latin' });
  assert.deepEqual(detectLanguage(HI), { language: 'hi', script: 'devanagari' });
  assert.deepEqual(detectLanguage(HINGLISH), { language: 'hinglish', script: 'latin' });
  assert.equal(detectLanguage('यह pyramid बहुत पुराना है').script, 'mixed');
});

test('syllable estimate handles Latin, digits and Devanagari conjuncts', () => {
  assert.equal(countSyllables('pyramid'), 3);
  assert.equal(countSyllables('the'), 1);
  assert.ok(countSyllables('3/60th') >= 3, 'digits are spoken');
  assert.equal(countSyllables('रहस्य'), 3); // र-ह-स्य (the virama joins स्+य)
  assert.equal(countSyllables('है।'), 1);
});

test('keywords, intensity and reveal markers are found in all three languages', () => {
  const en = analyzeNarration('Nobody knows the secret. But it aligns perfectly!');
  assert.ok(en.hasReveal);
  assert.ok(en.intensity > 0.5);
  assert.ok(en.words.find((w) => w.core === 'secret').isIntense);

  const hi = analyzeNarration(HI);
  assert.ok(hi.words.find((w) => w.core === 'रहस्य').score >= 2);
  assert.ok(hi.words.find((w) => w.core === 'का').isStopword);

  const hing = analyzeNarration(HINGLISH);
  assert.ok(hing.hasReveal, '"lekin" is a reveal marker');
  assert.ok(hing.hasQuestion);
});

test('estimated word timing is monotonic, fills the window, and is labelled as estimated', () => {
  const timed = timeWords(analyzeNarration(EN), { start: 0.12, end: 2.7 });
  assert.equal(timed.timingSource, 'estimated');
  assert.ok(Math.abs(timed.words[0].start - 0.12) < 1e-9);
  timed.words.forEach((w, i) => {
    assert.ok(w.end > w.start);
    if (i > 0) assert.ok(w.start >= timed.words[i - 1].end - 1e-9);
  });
  assert.ok(timed.words.at(-1).end <= 2.7 + 1e-6);
});

test('real word timestamps are used when they match, and rejected (with a warning) when they do not', () => {
  const analysis = analyzeNarration('Giza aligns north');
  const good = timeWords(analysis, { start: 0, end: 3, wordTimings: [{ start: 0.2, end: 0.6 }, { start: 0.7, end: 1.4 }, { start: 1.5, end: 2.1 }] });
  assert.equal(good.timingSource, 'aligned');
  assert.equal(good.words[1].start, 0.7);

  const bad = timeWords(analysis, { start: 0, end: 3, wordTimings: [{ start: 0.2, end: 0.6 }] });
  assert.equal(bad.timingSource, 'estimated', 'never pretends a mismatched alignment is exact');
  assert.equal(bad.warnings.length, 1);
});

for (const [name, text] of [['English', EN], ['Hindi', HI], ['Hinglish', HINGLISH]]) {
  test(`caption cues (${name}): short phrases, contiguous, every word kept exactly once`, () => {
    const tl = planTimeline({ narration: text, duration: 4 });
    assert.ok(tl.cues.length >= 2);
    assert.equal(tl.cues.map((c) => c.text).join(' '), text.replace(/\s+/g, ' '));
    tl.cues.forEach((cue, i) => {
      assert.ok(cue.words.length <= 8, `"${cue.text}" is short enough to read`);
      assert.ok(cue.end > cue.start);
      if (i > 0) assert.equal(cue.start, tl.cues[i - 1].end, 'no gap or overlap between cues');
      assert.ok(cue.words.filter((w) => w.emphasis).length <= 2, 'at most two highlighted words per phrase');
    });
    assert.equal(tl.cues.at(-1).end, 4);
  });
}

test('phrase breaks respect grammar: no dangling "of" in English, no stranded "hai" in Hinglish', () => {
  const en = planTimeline({ narration: EN, duration: 4 }).cues.map((c) => c.text);
  for (const text of en.slice(0, -1)) assert.ok(!/\b(of|the|a|with|within)$/i.test(text), `"${text}" ends on a function word`);
  const hing = planTimeline({ narration: HINGLISH, duration: 4 }).cues.map((c) => c.text);
  for (const text of hing.slice(1)) assert.ok(!/^(hai|hain|ka|ki|ke)\b/i.test(text), `"${text}" starts with a stranded particle`);
});

test('shots: cover the whole clip, cut on phrase boundaries, long enough to read', () => {
  for (const modelId of Object.keys(DIRECTOR_STYLES)) {
    for (const duration of [3, 4, 5]) {
      const tl = planTimeline({ narration: EN, duration, modelId });
      const cueStarts = new Set(tl.cues.map((c) => c.start));
      assert.equal(tl.shots[0].start, 0);
      assert.equal(tl.shots.at(-1).end, duration);
      assert.ok(tl.shots.length >= 1 && tl.shots.length <= 3);
      tl.shots.forEach((shot, i) => {
        assert.ok(shot.end - shot.start >= 0.9 - 1e-6, `${modelId}/${duration}s ${shot.id} lasts ${(shot.end - shot.start).toFixed(2)}s`);
        if (i > 0) {
          assert.equal(shot.start, tl.shots[i - 1].end);
          assert.ok(cueStarts.has(shot.start), `${modelId}/${duration}s cut at ${shot.start} is on a phrase boundary`);
          assert.notEqual(shot.type, tl.shots[i - 1].type, 'never the same move twice in a row');
        }
      });
    }
  }
});

test('transitions: clean cuts by default, at most one soft transition, dissolves stay short', () => {
  for (const modelId of Object.keys(DIRECTOR_STYLES)) {
    const tl = planTimeline({ narration: 'Nobody knows how it was built. But the Great Pyramid aligns with true north almost perfectly!', duration: 5, modelId });
    assert.equal(tl.shots[0].transitionIn.type, 'cut');
    const soft = tl.shots.filter((s) => s.transitionIn.type !== 'cut');
    assert.ok(soft.length <= 1, `${modelId}: ${soft.length} non-cut transitions`);
    for (const s of soft) {
      if (s.transitionIn.type === 'dissolve') assert.ok(s.transitionIn.duration <= 0.3);
      assert.ok(['dissolve', 'match-zoom'].includes(s.transitionIn.type));
    }
  }
});

test('a clip without text still gets evenly paced shots and no cues', () => {
  const tl = planTimeline({ narration: '', duration: 4, modelId: 'viral-hook-v1' });
  assert.equal(tl.cues.length, 0);
  assert.equal(tl.timingSource, 'none');
  assert.ok(tl.shots.length >= 2);
});

test('text that is too long for the clip is flagged, not hidden', () => {
  const tl = planTimeline({ narration: EN, duration: 3 });
  assert.ok(tl.pacing.textDensity > 1.3);
  assert.equal(tl.pacing.warnings.length, 1);
  const ok = planTimeline({ narration: 'Giza aligns with true north.', duration: 4 });
  assert.equal(ok.pacing.warnings.length, 0);
});

test('prompt direction overrides the opening move', () => {
  const { shots } = planShots({ duration: 4, modelId: 'viral-hook-v1', motionHint: { type: 'reveal' } });
  assert.equal(shots[0].type, 'reveal');
});

test('the timeline is deterministic', () => {
  const a = planTimeline({ narration: HI, duration: 4, modelId: 'cinematic-doc-v1', seed: 3 });
  const b = planTimeline({ narration: HI, duration: 4, modelId: 'cinematic-doc-v1', seed: 3 });
  assert.deepEqual(a, b);
});

test('buildCaptionCues handles an empty word list', () => {
  assert.deepEqual(buildCaptionCues([]), []);
});
