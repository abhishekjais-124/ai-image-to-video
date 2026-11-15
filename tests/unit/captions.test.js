import test from 'node:test';
import assert from 'node:assert/strict';
import {
  layoutCaptions,
  fitCue,
  approximateMeasurer,
  captionSafeZone,
  activeCueIndex,
  drawCaptions,
  scriptOf
} from '../../src/engine/captions.js';
import { planTimeline } from '../../src/engine/director.js';
import { createMockContext } from '../helpers.js';

const TEXTS = {
  english: 'The Great Pyramid of Giza aligns with true north within 3/60th of a single degree.',
  hindi: 'गीज़ा का महान पिरामिड आज भी एक रहस्य है। यह लगभग पूरी तरह उत्तर दिशा की ओर बना है।',
  hinglish: 'Kya aap jaante hain? Giza ka pyramid aaj bhi ek raaz hai, lekin sach kuch aur hai.'
};
const FORMATS = [
  { aspectRatio: '9:16', width: 1080, height: 1920 },
  { aspectRatio: '9:16', width: 1440, height: 2560 },
  { aspectRatio: '16:9', width: 1920, height: 1080 }
];

function layoutFor(text, format, extra = {}) {
  const tl = planTimeline({ narration: text, duration: 4 });
  return layoutCaptions({ measure: approximateMeasurer, ...format, title: 'Did you know?', cues: tl.cues, ...extra });
}

for (const [language, text] of Object.entries(TEXTS)) {
  for (const format of FORMATS) {
    test(`caption layout ${language} ${format.width}×${format.height}: inside the safe zone, at most two lines, never clipped`, () => {
      const layout = layoutFor(text, format);
      assert.equal(layout.withinSafeZone, true);
      assert.equal(layout.overflow, false);
      assert.ok(layout.maxLines <= 2);
      const zone = captionSafeZone(format);
      for (const cue of layout.cues) {
        for (const line of cue.lines) {
          assert.ok(line.x0 >= zone.left - 1 && line.x0 + line.width <= zone.right + 1, `line "${line.words.map((w) => w.text).join(' ')}" fits horizontally`);
          assert.ok(line.y + layout.lineHeight <= zone.bottom + 1, 'line is above the platform UI area');
        }
      }
      assert.ok(layout.bounds.y1 <= zone.bottom + layout.fontPx * 0.2, 'block (with its outline) ends at the safe-zone bottom');
    });
  }
}

test('words are laid out whole — a Devanagari word is never split (shaping stays intact)', () => {
  const layout = layoutFor(TEXTS.hindi, FORMATS[0]);
  const drawn = layout.cues.flatMap((c) => c.lines.flatMap((l) => l.words.map((w) => w.text)));
  assert.deepEqual(drawn, TEXTS.hindi.split(' '));
  assert.equal(layout.script, 'devanagari');
  assert.equal(scriptOf('raaz'), 'latin');
});

test('Devanagari gets more line height than Latin (room for matras)', () => {
  const hi = layoutFor(TEXTS.hindi, FORMATS[0]);
  const en = layoutFor(TEXTS.english, FORMATS[0]);
  assert.ok(hi.lineHeight / hi.fontPx > en.lineHeight / en.fontPx);
});

test('one font size for every phrase in a clip (consistent typography)', () => {
  const layout = layoutFor(TEXTS.english, FORMATS[0]);
  assert.ok(Number.isFinite(layout.fontPx) && layout.fontPx >= 48);
  for (const cue of layout.cues) assert.ok(cue.height <= layout.lineHeight * 2 + 1);
});

test('a single very long word shrinks the font instead of clipping', () => {
  const cue = { id: 'c', start: 0, end: 2, text: 'x', words: [{ text: 'Pneumonoultramicroscopicsilicovolcanoconiosis', start: 0, end: 2 }] };
  const fit = fitCue(approximateMeasurer, cue, { maxWidth: 864, baseFont: 72, minFont: 48 });
  assert.equal(fit.lines.length, 1);
  assert.ok(fit.widths[0] <= 864, 'the word fits on the line');
  assert.ok(fit.fontPx < 48, 'font went below the normal minimum only because nothing else fits');
});

test('dense text is reported as overflow rather than silently drawn in three lines', () => {
  const words = Array.from({ length: 16 }, (_, i) => ({ text: `longerword${i}`, start: i * 0.1, end: i * 0.1 + 0.1 }));
  const layout = layoutCaptions({ measure: approximateMeasurer, width: 1080, height: 1920, cues: [{ id: 'c', start: 0, end: 2, text: 't', words }] });
  assert.equal(layout.overflow, true);
});

test('static mode keeps the whole caption on screen as one block', () => {
  const words = TEXTS.english.split(' ').map((text) => ({ text, start: 0, end: 4, emphasis: false }));
  const layout = layoutCaptions({
    measure: approximateMeasurer, width: 1080, height: 1920, title: 'Did you know?',
    cues: [{ id: 'cue-1', start: 0, end: 4, text: TEXTS.english, words }], style: { mode: 'static' }
  });
  assert.equal(layout.cues.length, 1);
  assert.equal(layout.withinSafeZone, true);
  assert.equal(layout.overflow, false);
});

test('no title and no text → nothing to draw, no crash', () => {
  const layout = layoutCaptions({ measure: approximateMeasurer, width: 1080, height: 1920, title: '', cues: [] });
  assert.equal(layout.title, null);
  assert.equal(layout.cues.length, 0);
  const { ctx, log } = createMockContext();
  drawCaptions(ctx, layout, { t: 1 });
  assert.equal(log.texts.length, 0);
});

test('activeCueIndex: the right phrase for each moment', () => {
  const cues = [{ start: 0.1, end: 1 }, { start: 1, end: 2 }, { start: 2, end: 3 }];
  assert.equal(activeCueIndex(cues, 0), -1);
  assert.equal(activeCueIndex(cues, 0.5), 0);
  assert.equal(activeCueIndex(cues, 1), 1);
  assert.equal(activeCueIndex(cues, 2.9), 2);
});

test('drawing: only the active phrase is drawn, and text never leaves the canvas', () => {
  const layout = layoutFor(TEXTS.english, FORMATS[0]);
  const { ctx, log } = createMockContext(1080, 1920);
  drawCaptions(ctx, layout, { t: layout.cues[1].start + 0.5, timingSource: 'estimated' });
  const words = log.texts.map((t) => t.text);
  assert.ok(words.includes('DID YOU KNOW?'), 'title chip is drawn (upper-cased for Latin)');
  for (const w of layout.cues[1].lines.flatMap((l) => l.words)) assert.ok(words.includes(w.text));
  for (const w of layout.cues[0].lines.flatMap((l) => l.words)) {
    if (!layout.cues[1].text.includes(w.text)) assert.ok(!words.includes(w.text), `"${w.text}" from the previous phrase is gone`);
  }
  for (const t of log.texts) assert.ok(t.x >= 0 && t.x <= 1080 && t.y >= 0 && t.y <= 1920);
});

test('per-word highlight is used only with real timestamps', () => {
  const tl = planTimeline({ narration: 'Giza aligns north', duration: 3, wordTimings: [{ start: 0.2, end: 0.8 }, { start: 0.9, end: 1.6 }, { start: 1.7, end: 2.4 }] });
  assert.equal(tl.timingSource, 'aligned');
  const layout = layoutCaptions({ measure: approximateMeasurer, width: 1080, height: 1920, cues: tl.cues });

  const aligned = createMockContext();
  drawCaptions(aligned.ctx, layout, { t: 1.0, timingSource: 'aligned', style: { accentColor: '#ffd166', textColor: '#ffffff' } });
  const spoken = aligned.log.texts.find((t) => t.text === 'aligns');
  const upcoming = aligned.log.texts.find((t) => t.text === 'north');
  assert.equal(spoken.fill, '#ffd166', 'the word being spoken is highlighted');
  assert.ok(upcoming.alpha < spoken.alpha, 'words not yet spoken are dimmed');

  const estimated = createMockContext();
  drawCaptions(estimated.ctx, layout, { t: 1.0, timingSource: 'estimated', style: { accentColor: '#ffd166', textColor: '#ffffff' } });
  const plain = estimated.log.texts.find((t) => t.text === 'north');
  assert.ok(plain.alpha > 0.95, 'with estimated timing the phrase is shown as a unit, not karaoke');
});
