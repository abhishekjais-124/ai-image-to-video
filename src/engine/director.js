// Scene director — turns the narration text into a structured, deterministic
// timeline: caption cues, shots cut on phrase boundaries, transitions and
// emphasis beats. Pure functions (no canvas, no network, no model downloads),
// so the same input always produces the same timeline and it is unit-testable.
//
// Works for English, Hindi (Devanagari) and Hinglish (Hindi in Latin script).
//
// Honest limits:
//  • There is no audio or speech model in this project. Unless the caller
//    passes real word timestamps (`wordTimings`), timing is ESTIMATED from
//    syllable weights and punctuation and the timeline says so
//    (`timingSource: 'estimated'`). The caption renderer only does per-word
//    karaoke highlighting when timings are 'aligned'.
//  • "Understanding" here is lexical (keywords, emphasis, pauses, reveal
//    markers), not a language model.

const FPS = 30;
const snap = (t) => Math.round(t * FPS) / FPS;
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-z]/;
const EDGE_PUNCT = /^[\s"'“”‘’()[\]{}.,!?;:—–\-…।॥*]+|[\s"'“”‘’()[\]{}.,!?;:—–\-…।॥*]+$/g;
const LONG_PAUSE = /[.!?।॥…]["'”’)\]]*$/;
const SHORT_PAUSE = /[,;:—–]["'”’)\]]*$/;

const STOPWORDS_EN = new Set(
  ('the a an of and or to in on at is are was were be been being it its this that these those with within for from by as ' +
    'but not you your we our they their he she his her has have had do does did will would can could so if than then there ' +
    'here about into over up down out just very also which who whom what when where why how all any each every some such no nor ' +
    'too s t am i me my').split(' ')
);
const STOPWORDS_HINGLISH = new Set(
  ('hai hain ho hota hoti hote tha thi the ka ki ke ko se me mein main par pe aur ya ek yeh ye woh wo is us kya kyun kyu kyon ' +
    'kaise nahi nahin na bhi hi to toh jo jab tab kuch apna apni apne tum aap hum mera meri mere liye tak sab bahut raha rahi ' +
    'rahe gaya gayi gaye kar karta karti karte kiya kiye hua hui hue wala wali wale koi kisi yahan wahan ab phir sirf').split(' ')
);
const STOPWORDS_HI = new Set(
  ('है हैं था थी थे का की के को से में पर और या एक यह ये वह वो इस उस क्या क्यों कैसे नहीं न भी ही तो जो जब तब कुछ अपना अपनी अपने ' +
    'तुम आप हम मेरा मेरी मेरे लिए तक सब बहुत रहा रही रहे गया गई गए कर करता करती करते किया किए हो होता होती होते ने हुआ हुई हुए ' +
    'वाला वाली वाले कोई किसी यहाँ वहाँ अब फिर सिर्फ').split(' ')
);

// Hinglish function words that almost never occur in English text — used to tell the two apart.
const HINGLISH_MARKERS = new Set(
  ('hai hain tha thi ka ki ke ko mein nahi nahin kya kyun kyu kaise aur yeh woh bhi toh hota hoti hote raha rahi rahe ' +
    'gaya gayi kar karta karte kiya liye sabse bahut apna apni apne').split(' ')
);

const INTENSITY_WORDS = new Set(
  ('secret secrets mystery mysterious shocking incredible impossible never deadly ancient hidden unbelievable amazing insane ' +
    'biggest largest oldest fastest tallest deepest only first exactly perfectly truth danger dangerous lost forbidden unknown ' +
    'strange billion million thousand nobody everything nothing forever ' +
    'raaz rahasya rahasyamayi khatarnak ajeeb anokha sabse asli sach khaufnaak gazab kamaal hairan prachin purana chhupa adbhut ' +
    'रहस्य रहस्यमयी राज़ राज खतरनाक अजीब अनोखा सबसे असली सच गज़ब कमाल हैरान प्राचीन पुराना छिपा अद्भुत कभी असंभव').split(' ')
);

const REVEAL_WORDS = new Set(
  ('but actually however yet until suddenly revealed turns because instead ' +
    'lekin magar asal darasal kyunki achanak ' +
    'लेकिन मगर असल दरअसल क्योंकि अचानक परंतु किंतु').split(' ')
);

/** Detect the narration language from script and function words. */
export function detectLanguage(text) {
  const str = String(text || '');
  const hasDeva = DEVANAGARI.test(str);
  const hasLatin = LATIN.test(str);
  if (hasDeva && hasLatin) {
    const deva = (str.match(/[ऀ-ॿ]/g) || []).length;
    const latin = (str.match(/[A-Za-z]/g) || []).length;
    return { language: deva >= latin ? 'hi' : 'hinglish', script: 'mixed' };
  }
  if (hasDeva) return { language: 'hi', script: 'devanagari' };
  const tokens = str.toLowerCase().split(/\s+/).map((w) => w.replace(EDGE_PUNCT, '')).filter(Boolean);
  const markers = tokens.filter((w) => HINGLISH_MARKERS.has(w)).length;
  if (tokens.length > 0 && (markers >= 2 || markers / tokens.length >= 0.15)) {
    return { language: 'hinglish', script: 'latin' };
  }
  return { language: 'en', script: 'latin' };
}

/** Approximate spoken syllables of one word (drives estimated timing). */
export function countSyllables(word) {
  const core = String(word || '').replace(EDGE_PUNCT, '');
  if (!core) return 1;
  if (DEVANAGARI.test(core)) {
    const aksharas = (core.match(/[ऄ-हक़-ॡॲ-ॿ]/g) || []).length;
    const viramas = (core.match(/्/g) || []).length;
    return Math.max(1, aksharas - viramas);
  }
  const digits = (core.match(/\d/g) || []).length;
  const vowelGroups = (core.toLowerCase().match(/[aeiouy]+/g) || []).length;
  // "3/60th", "2,560": every digit is spoken, separators add a beat.
  const separators = digits > 0 ? (core.match(/[/.,:-]/g) || []).length : 0;
  return Math.max(1, vowelGroups + digits + separators);
}

function isStopword(lower, language) {
  if (STOPWORDS_HI.has(lower)) return true;
  if (language === 'hinglish') return STOPWORDS_HINGLISH.has(lower) || STOPWORDS_EN.has(lower);
  if (language === 'en') return STOPWORDS_EN.has(lower);
  return STOPWORDS_HINGLISH.has(lower);
}

/**
 * Lexical analysis of the narration: words with pause/keyword information,
 * overall emotional intensity, and reveal/question flags.
 */
export function analyzeNarration(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  const { language, script } = detectLanguage(raw);
  const tokens = raw ? raw.split(' ') : [];

  let sentenceStart = true;
  const words = tokens.map((token, index) => {
    const core = token.replace(EDGE_PUNCT, '');
    const lower = core.toLowerCase();
    const stop = !core || isStopword(lower, language);
    const pauseAfter = LONG_PAUSE.test(token) ? 'long' : SHORT_PAUSE.test(token) ? 'short' : 'none';

    let score = 0;
    if (!stop) score += 1;
    if (/\d/.test(core)) score += 2;
    if (INTENSITY_WORDS.has(lower)) score += 1.5;
    if (!stop && (DEVANAGARI.test(core) ? core.length >= 6 : core.length >= 8)) score += 0.5;
    // A capitalised word that does not start a sentence is usually a name / place.
    if (!sentenceStart && /^[A-Z][a-z]/.test(core) && !stop) score += 1;
    if (/[!?]/.test(token)) score += 0.5;

    const word = {
      index,
      text: token,
      core,
      syllables: countSyllables(token),
      isStopword: stop,
      isReveal: REVEAL_WORDS.has(lower),
      isIntense: INTENSITY_WORDS.has(lower),
      pauseAfter,
      score
    };
    sentenceStart = pauseAfter === 'long';
    return word;
  });

  const content = words.filter((w) => !w.isStopword);
  const exclaim = (raw.match(/[!?]/g) || []).length;
  const intense = words.filter((w) => w.isIntense).length;
  const intensity = clamp(
    0.2 + (intense / Math.max(1, content.length)) * 1.6 + Math.min(0.3, exclaim * 0.12) + (words.some((w) => /\d/.test(w.core)) ? 0.1 : 0),
    0,
    1
  );

  return {
    text: raw,
    language,
    script,
    words,
    intensity: Number(intensity.toFixed(3)),
    hasQuestion: /[?]/.test(raw),
    hasReveal: words.some((w) => w.isReveal)
  };
}

const PAUSE_UNITS = { none: 0, short: 0.6, long: 1.3 };
// Comfortable narration pace, in syllable units per second (≈ 150 wpm English).
const NATURAL_UNITS_PER_SECOND = 5.2;

/**
 * Give every word a [start, end]. Uses real timestamps when supplied and they
 * match the text; otherwise distributes time by syllable weight and pauses and
 * labels the result as estimated.
 */
export function timeWords(analysis, { start, end, wordTimings = null }) {
  const words = analysis.words;
  const warnings = [];

  if (Array.isArray(wordTimings) && wordTimings.length > 0) {
    const usable =
      wordTimings.length === words.length &&
      wordTimings.every((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end >= w.start);
    if (usable) {
      return {
        timingSource: 'aligned',
        warnings,
        words: words.map((w, i) => ({ ...w, start: wordTimings[i].start, end: wordTimings[i].end }))
      };
    }
    warnings.push(
      `wordTimings ignored: ${wordTimings.length} timestamps supplied for ${words.length} words (or invalid values) — using estimated timing`
    );
  }

  const unitsOf = (w) => 0.35 + 0.65 * w.syllables;
  const totalUnits = words.reduce((sum, w) => sum + unitsOf(w) + PAUSE_UNITS[w.pauseAfter], 0);
  const span = Math.max(0.1, end - start);
  const perUnit = totalUnits > 0 ? span / totalUnits : 0;

  let cursor = start;
  const timed = words.map((w) => {
    const dur = unitsOf(w) * perUnit;
    const out = { ...w, start: cursor, end: cursor + dur };
    cursor += dur + PAUSE_UNITS[w.pauseAfter] * perUnit;
    return out;
  });

  return {
    timingSource: 'estimated',
    warnings,
    words: timed,
    naturalDuration: totalUnits / NATURAL_UNITS_PER_SECOND
  };
}

/**
 * Group timed words into caption cues: one thought per cue, at most two lines,
 * broken at punctuation first and never between a function word and the word
 * it belongs to ("of | Giza").
 */
export function buildCaptionCues(timedWords, { language = 'en', script = 'latin', clipEnd, maxWordsPerCue = 7 } = {}) {
  if (!timedWords.length) return [];
  const maxLineChars = script === 'latin' ? 22 : 24;
  const maxCueChars = maxLineChars * 2 - 4;
  const visualLength = (w) => w.text.replace(/[़्ऀ-ःा-ौ]/g, '').length;

  const lengthOf = (list) => list.reduce((sum, w, k) => sum + visualLength(w) + (k ? 1 : 0), 0);
  // English function words bind forward ("of | Giza" is a bad break); Hindi/Hinglish
  // postpositions and auxiliaries bind backward ("raaz | hai" is a bad break).
  const badBreakAfter = (list, i) =>
    language === 'en' ? list[i].isStopword : Boolean(list[i + 1] && list[i + 1].isStopword);

  // 1. Sentences end at long pauses.
  const sentences = [];
  let sentence = [];
  for (const w of timedWords) {
    sentence.push(w);
    if (w.pauseAfter === 'long') {
      sentences.push(sentence);
      sentence = [];
    }
  }
  if (sentence.length) sentences.push(sentence);

  // 2. A sentence that does not fit one cue is split into balanced parts at the best break points.
  const groups = [];
  for (const list of sentences) {
    const total = lengthOf(list);
    const parts = Math.max(Math.ceil(total / maxCueChars), Math.ceil(list.length / maxWordsPerCue));
    if (parts <= 1) {
      groups.push(list);
      continue;
    }
    const breaks = [];
    let from = 0;
    for (let k = 1; k < parts; k++) {
      const ideal = (total * k) / parts;
      let best = -1;
      let bestCost = Infinity;
      let running = lengthOf(list.slice(0, from));
      for (let i = from; i < list.length - 1; i++) {
        running += visualLength(list[i]) + (i > 0 ? 1 : 0);
        let cost = Math.abs(running - ideal);
        if (badBreakAfter(list, i)) cost += 8;
        if (list[i].pauseAfter === 'short') cost -= 6;
        if (cost < bestCost) {
          bestCost = cost;
          best = i;
        }
      }
      if (best < 0) break;
      breaks.push(best);
      from = best + 1;
    }
    let startAt = 0;
    for (const br of breaks) {
      groups.push(list.slice(startAt, br + 1));
      startAt = br + 1;
    }
    if (startAt < list.length) groups.push(list.slice(startAt));
  }

  // Merge cues too short to read (a lone word, or under ~0.55s) into a neighbour when it fits.
  const merged = [];
  for (const group of groups) {
    const prev = merged[merged.length - 1];
    const dur = group[group.length - 1].end - group[0].start;
    const size = group.reduce((s, c) => s + visualLength(c) + 1, 0);
    if (prev) {
      const prevSize = prev.reduce((s, c) => s + visualLength(c) + 1, 0);
      const prevEndsSentence = prev[prev.length - 1].pauseAfter === 'long';
      if ((group.length === 1 || dur < 0.55) && prevSize + size <= maxCueChars + 6 && !prevEndsSentence) {
        prev.push(...group);
        continue;
      }
    }
    merged.push([...group]);
  }

  return merged.map((group, i) => {
    const next = merged[i + 1];
    // Emphasis: at most two keywords per cue, and only genuinely strong ones.
    const ranked = group
      .filter((w) => w.score >= 1.5)
      .sort((a, b) => b.score - a.score)
      .slice(0, 2)
      .map((w) => w.index);
    const start = snap(group[0].start);
    const end = snap(next ? next[0].start : clipEnd ?? group[group.length - 1].end);
    return {
      id: `cue-${i + 1}`,
      start,
      end: Math.max(end, start + 1 / FPS),
      text: group.map((w) => w.text).join(' '),
      language,
      isReveal: group.some((w) => w.isReveal),
      endsSentence: group[group.length - 1].pauseAfter === 'long',
      words: group.map((w) => ({
        text: w.text,
        start: Number(w.start.toFixed(3)),
        end: Number(w.end.toFixed(3)),
        emphasis: ranked.includes(w.index)
      }))
    };
  });
}

/** Editing style per director model: energy drives shot length and transition choice. */
export const DIRECTOR_STYLES = {
  'saliency-vision': {
    energy: 0.5, shotLength: 1.8, handheld: 0, beatPunch: 0,
    patterns: { 1: ['push-in'], 2: ['establishing', 'detail'], 3: ['establishing', 'detail', 'push-in'] }
  },
  'viral-hook-v1': {
    energy: 0.9, shotLength: 1.4, handheld: 0, beatPunch: 0.018,
    patterns: { 1: ['push-in'], 2: ['push-in', 'detail'], 3: ['push-in', 'detail', 'reveal'] }
  },
  'cinematic-doc-v1': {
    energy: 0.25, shotLength: 2.4, handheld: 0, beatPunch: 0,
    patterns: { 1: ['reveal'], 2: ['pan', 'reveal'], 3: ['establishing', 'pan', 'reveal'] }
  },
  'mystery-noir-v1': {
    energy: 0.35, shotLength: 2.2, handheld: 0.6, beatPunch: 0,
    patterns: { 1: ['hold'], 2: ['hold', 'detail'], 3: ['hold', 'detail', 'push-in'] }
  },
  'scifi-neural-v1': {
    energy: 0.7, shotLength: 1.6, handheld: 0, beatPunch: 0.012,
    patterns: { 1: ['push-in'], 2: ['pan', 'push-in'], 3: ['pan', 'detail', 'push-in'] }
  }
};

const MIN_SHOT_SECONDS = 0.9;
const DISSOLVE_SECONDS = 8 / FPS;

/**
 * Decide the shots: how many, where they cut, what each one is, and how they join.
 * Cuts land on phrase boundaries (caption cue starts), never on a fixed grid.
 */
export function planShots({ duration, cues = [], analysis = null, modelId = 'saliency-vision', seed = 1, motionHint = null }) {
  const style = DIRECTOR_STYLES[modelId] || DIRECTOR_STYLES['saliency-vision'];
  const intensity = analysis?.intensity ?? 0.3;

  // Calm narration earns longer shots; intense narration slightly shorter ones.
  const targetLength = style.shotLength * (1.12 - 0.3 * intensity);
  let count = clamp(Math.round(duration / targetLength), 1, 3);

  // Candidate cut points: starts of caption cues (i.e. real phrase boundaries).
  const candidates = cues.slice(1).map((c, i) => ({ t: c.start, afterSentence: cues[i].endsSentence, isReveal: c.isReveal }));
  const boundaries = [];
  if (count > 1) {
    const wanted = [];
    for (let k = 1; k < count; k++) wanted.push((duration * k) / count);
    for (const ideal of wanted) {
      const prevT = boundaries.length ? boundaries[boundaries.length - 1].t : 0;
      let best = null;
      if (cues.length === 0) {
        best = { t: snap(ideal), afterSentence: false, isReveal: false };
      } else {
        for (const c of candidates) {
          if (c.t - prevT < MIN_SHOT_SECONDS || duration - c.t < MIN_SHOT_SECONDS) continue;
          const dist = Math.abs(c.t - ideal) - (c.afterSentence ? 0.12 : 0) - (c.isReveal ? 0.1 : 0);
          if (dist <= 0.55 && (!best || dist < best.dist)) best = { ...c, dist };
        }
      }
      if (best) boundaries.push({ t: snap(best.t), afterSentence: best.afterSentence, isReveal: best.isReveal });
    }
    count = boundaries.length + 1;
  }

  let types = [...(style.patterns[count] || style.patterns[1])];
  // Prompt direction overrides the opening move ("pull back", "pan left", …).
  if (motionHint?.type) types[0] = motionHint.type;
  // Seed 3, 5, … swap in an alternative middle so variations are genuinely different edits.
  if (count === 3 && seed % 3 === 0) types[1] = types[1] === 'detail' ? 'pan' : 'detail';
  // Never the same move twice in a row.
  for (let i = 1; i < types.length; i++) {
    if (types[i] === types[i - 1]) types[i] = types[i] === 'detail' ? 'hold' : 'detail';
  }

  const times = [0, ...boundaries.map((b) => b.t), duration];
  let softTransitionUsed = false;

  const shots = types.map((type, i) => {
    const isLast = i === types.length - 1;
    const boundary = i > 0 ? boundaries[i - 1] : null;
    let transitionIn = { type: 'cut', duration: 0 };

    if (boundary && !softTransitionUsed) {
      const shotSpan = times[i + 1] - times[i];
      if (style.energy <= 0.4 && boundary.afterSentence && shotSpan >= DISSOLVE_SECONDS * 3) {
        // A calm cut on a full stop reads better as a short, gentle dissolve.
        transitionIn = { type: 'dissolve', duration: Number(DISSOLVE_SECONDS.toFixed(4)) };
        softTransitionUsed = true;
      } else if (style.energy >= 0.65 && (boundary.isReveal || isLast)) {
        // Motion-matched cut: the outgoing move accelerates into the cut, the incoming one decelerates out of it.
        transitionIn = { type: 'match-zoom', duration: 0 };
        softTransitionUsed = true;
      }
    }

    return {
      id: `shot-${i + 1}`,
      start: times[i],
      end: times[i + 1],
      type,
      intent: i === 0 ? 'hook' : isLast ? 'payoff' : 'build',
      easing: types.length === 1 ? 'drift' : isLast || type === 'reveal' ? 'ease-out' : 'linear',
      transitionIn,
      motionScale: Number((motionHint?.motionScale ?? (isLast ? 1.1 : 1) * (0.85 + 0.4 * style.energy)).toFixed(3))
    };
  });

  // Apply the match-cut easing to the shot that leads into it.
  shots.forEach((shot, i) => {
    if (i > 0 && shot.transitionIn.type === 'match-zoom') {
      shots[i - 1].easing = i - 1 === 0 ? 'ease-in' : 'linear';
      shot.easing = 'ease-out';
    }
  });

  return { shots, style };
}

/**
 * Full timeline for one clip. This is the structured, deterministic plan the
 * renderer executes: caption cues, shots, transitions, beats and pacing notes.
 */
export function planTimeline({
  narration = '',
  duration = 4,
  modelId = 'saliency-vision',
  seed = 1,
  wordTimings = null,
  motionHint = null
} = {}) {
  const analysis = analyzeNarration(narration);
  const lead = 0.12;
  const tail = Math.min(0.4, duration * 0.1);
  const timed = timeWords(analysis, { start: lead, end: duration - tail, wordTimings });
  const cues = buildCaptionCues(timed.words, {
    language: analysis.language,
    script: analysis.script,
    clipEnd: duration
  });

  const { shots, style } = planShots({ duration, cues, analysis, modelId, seed, motionHint });

  // Beats: where the strongest words land. Used for a restrained emphasis, never a flash.
  const beats = timed.words
    .filter((w) => w.score >= 2.5 || w.isReveal)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((w) => ({
      t: Number(w.start.toFixed(3)),
      kind: w.isReveal ? 'reveal' : 'emphasis',
      word: w.core,
      strength: Number(clamp(w.score / 4, 0.4, 1).toFixed(2))
    }))
    .sort((a, b) => a.t - b.t);

  const warnings = [...timed.warnings];
  const speakingSpan = duration - lead - tail;
  const density = timed.naturalDuration ? timed.naturalDuration / speakingSpan : null;
  if (density && density > 1.3) {
    warnings.push(
      `Text is dense for a ${duration}s clip: it needs about ${timed.naturalDuration.toFixed(1)}s at a natural reading pace. ` +
        'Captions will change quickly — shorten the text or use a longer clip.'
    );
  }

  return {
    version: 1,
    // What this timeline was planned from — the renderer re-plans when the text or duration changes.
    source: { text: analysis.text, duration, modelId, seed },
    timingSource: analysis.words.length ? timed.timingSource : 'none',
    language: analysis.language,
    script: analysis.script,
    intensity: analysis.intensity,
    cues,
    shots,
    beats,
    style: { modelId, energy: style.energy, handheld: style.handheld, beatPunch: style.beatPunch },
    pacing: {
      shotCount: shots.length,
      averageShotSeconds: Number((duration / shots.length).toFixed(2)),
      wordsPerSecond: Number((analysis.words.length / Math.max(0.1, speakingSpan)).toFixed(2)),
      textDensity: density ? Number(density.toFixed(2)) : null,
      warnings
    }
  };
}
