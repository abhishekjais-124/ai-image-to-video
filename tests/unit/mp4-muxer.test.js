import test from 'node:test';
import assert from 'node:assert/strict';
import {
  muxH264SamplesToMp4,
  inspectMp4Buffer,
  extractH264Samples,
  normalizeNalSample,
  isLengthPrefixedAvcc,
  parseH264Sps,
  readSpsFromAvcC,
  colourInfoFromAvcC,
  parseMp4Structure
} from '../../src/engine/mp4-muxer.js';
import { REAL_AVCC, makeAvccSample, makeSamples } from '../helpers.js';

test('regression: an AVCC NAL of 256–511 bytes is not mistaken for an Annex-B start code', () => {
  // Length 0x000001b6 → the sample begins 00 00 01 b6, byte-identical to a 3-byte start code.
  // The old muxer rewrote such samples into an invalid NAL (type 22) and the clip's tail would not decode.
  for (const length of [256, 300, 438, 511]) {
    const sample = makeAvccSample(length, 0x21);
    assert.deepEqual([sample[0], sample[1], sample[2]], [0, 0, 1]);
    assert.equal(isLengthPrefixedAvcc(sample), true);
    const { avccBytes } = normalizeNalSample(sample);
    assert.deepEqual(avccBytes, sample, `sample with a ${length}-byte NAL must pass through untouched`);
    assert.equal(avccBytes[4] & 0x1f, 1, 'NAL type stays a coded slice');
  }
});

test('Annex-B samples are converted to AVCC and SPS/PPS are extracted', () => {
  const sps = [0x67, 0x42, 0x00, 0x28, 0xab, 0x40];
  const pps = [0x68, 0xce, 0x3c, 0x80];
  const idr = [0x65, 0x88, 0x84, 0x21, 0xa0];
  const annexB = Uint8Array.from([0, 0, 0, 1, ...sps, 0, 0, 0, 1, ...pps, 0, 0, 1, ...idr]);
  const out = normalizeNalSample(annexB);
  assert.deepEqual([...out.sps], sps);
  assert.deepEqual([...out.pps], pps);
  assert.equal(isLengthPrefixedAvcc(out.avccBytes), true);
});

test('garbage that is neither AVCC nor Annex-B is rejected, not muxed', () => {
  assert.throws(() => normalizeNalSample(Uint8Array.from([9, 9, 9, 9, 9, 9])), /neither/);
});

test('mux → inspect: frame count, constant 30 fps, duration, keyframes, fast start', () => {
  const samples = makeSamples(90);
  const mp4 = muxH264SamplesToMp4({ width: 1080, height: 1920, fps: 30, avcDescription: REAL_AVCC, samples });
  const info = inspectMp4Buffer(mp4);
  assert.equal(info.validMp4, true, info.problems.join('; '));
  assert.equal(info.frameCount, 90);
  assert.equal(info.fps, 30);
  assert.equal(info.isConstant30Fps, true);
  assert.equal(info.durationSec, 3);
  assert.equal(info.width, 1080);
  assert.equal(info.height, 1920);
  assert.equal(info.fastStart, true);
  assert.equal(info.keyframeCount, 3);
  assert.equal(info.hasAudioTrack, false);
  assert.deepEqual(info.topBoxes, ['ftyp', 'moov', 'mdat']);
});

test('demux round trip: every sample comes back byte-identical with valid timestamps', () => {
  const samples = makeSamples(45, { size: (i) => 250 + i * 9 }); // includes 256–511 byte NALs
  const mp4 = muxH264SamplesToMp4({ width: 1080, height: 1920, fps: 30, avcDescription: REAL_AVCC, samples });
  const out = extractH264Samples(mp4);
  assert.deepEqual(out.problems, []);
  assert.equal(out.samples.length, 45);
  out.samples.forEach((s, i) => {
    assert.deepEqual(s.data, samples[i].data, `sample ${i}`);
    assert.equal(s.isKeyframe, samples[i].isKeyframe);
    assert.equal(s.timestampUs, Math.round((i * 1_000_000) / 30));
    if (i > 0) assert.ok(s.timestampUs > out.samples[i - 1].timestampUs, 'timestamps strictly increase');
  });
  assert.equal(out.config.codec, 'avc1.420028');
});

test('colour tag follows the bitstream (limited range), never a hard-coded full-range flag', () => {
  const sps = parseH264Sps(readSpsFromAvcC(REAL_AVCC));
  assert.equal(sps.width, 1080);
  assert.equal(sps.height, 1920);
  assert.equal(sps.fullRange, false);
  assert.equal(colourInfoFromAvcC(REAL_AVCC).fullRange, false);

  const mp4 = muxH264SamplesToMp4({ width: 1080, height: 1920, avcDescription: REAL_AVCC, samples: makeSamples(3) });
  const info = inspectMp4Buffer(mp4);
  assert.equal(info.colour.fullRange, false);
  assert.equal(info.colour.fullRange, info.bitstreamFullRange, 'container and bitstream agree');
});

test('muxer refuses input that would produce an undecodable file', () => {
  assert.throws(() => muxH264SamplesToMp4({ width: 1080, height: 1920, samples: [] }), /zero encoded/);
  // No decoder config and no SPS/PPS in the stream: must fail instead of inventing parameter sets.
  assert.throws(() => muxH264SamplesToMp4({ width: 1080, height: 1920, samples: makeSamples(3) }), /no decoder configuration/);
  const notKey = makeSamples(3);
  notKey[0].isKeyframe = false;
  assert.throws(() => muxH264SamplesToMp4({ width: 1080, height: 1920, avcDescription: REAL_AVCC, samples: notKey }), /not a keyframe/);
  const withEmpty = makeSamples(3);
  withEmpty[1].data = new Uint8Array(0);
  assert.throws(() => muxH264SamplesToMp4({ width: 1080, height: 1920, avcDescription: REAL_AVCC, samples: withEmpty }), /is empty/);
});

test('a truncated (incomplete) file is reported, not accepted', () => {
  const mp4 = muxH264SamplesToMp4({ width: 1080, height: 1920, avcDescription: REAL_AVCC, samples: makeSamples(30) });
  const cut = mp4.subarray(0, mp4.length - 4000);
  const info = inspectMp4Buffer(cut);
  assert.equal(info.validMp4, false);
  assert.ok(info.problems.length > 0);
  assert.ok(info.problems.some((p) => /truncated|outside/i.test(p)), info.problems.join('; '));
});

test('a file without moov is reported as not finalized', () => {
  const mp4 = muxH264SamplesToMp4({ width: 1080, height: 1920, avcDescription: REAL_AVCC, samples: makeSamples(5) });
  const structure = parseMp4Structure(mp4.subarray(0, 32));
  assert.equal(structure.video, null);
  const out = extractH264Samples(mp4.subarray(0, 32));
  assert.ok(out.problems.some((p) => /moov/.test(p)));
});
