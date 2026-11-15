// Zero-Dependency ISO-BMFF H.264 (avc1) MP4 Multiplexer & Binary Verifier
// Produces FastStart (moov-before-mdat) MP4 files locked at 30.000 FPS Constant Frame Rate (CFR).
// Works 100% offline in Browser, Antigravity, Claude Desktop, and Codex.

const TIMESCALE = 30000; // 30,000 ticks/sec -> 1000 ticks/frame = exact 30.000 FPS CFR

function asciiBytes(str) {
  const out = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    out[i] = str.charCodeAt(i) & 0xff;
  }
  return out;
}

function u16(val) {
  return new Uint8Array([(val >>> 8) & 0xff, val & 0xff]);
}

function u32(val) {
  return new Uint8Array([
    (val >>> 24) & 0xff,
    (val >>> 16) & 0xff,
    (val >>> 8) & 0xff,
    val & 0xff
  ]);
}

function concatArrays(arrays) {
  let totalLen = 0;
  for (const a of arrays) totalLen += a.byteLength;
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const a of arrays) {
    out.set(a, offset);
    offset += a.byteLength;
  }
  return out;
}

function box(type, ...payloads) {
  const body = concatArrays(payloads);
  const size = 8 + body.byteLength;
  return concatArrays([u32(size), asciiBytes(type), body]);
}

function fullBox(type, version, flags, ...payloads) {
  const vf = new Uint8Array([
    version & 0xff,
    (flags >>> 16) & 0xff,
    (flags >>> 8) & 0xff,
    flags & 0xff
  ]);
  return box(type, vf, ...payloads);
}

/**
 * True when `bytes` is a well-formed AVCC sample: a sequence of 4-byte big-endian
 * NAL lengths that consumes the buffer exactly, each NAL with a valid header.
 */
export function isLengthPrefixedAvcc(bytes) {
  let offset = 0;
  let nalCount = 0;
  while (offset + 4 <= bytes.length) {
    const len =
      ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    if (len === 0 || offset + 4 + len > bytes.length) return false;
    const header = bytes[offset + 4];
    const nalType = header & 0x1f;
    // forbidden_zero_bit must be 0; types 0 and 24+ never appear in an MP4 AVC sample.
    if ((header & 0x80) !== 0 || nalType === 0 || nalType > 23) return false;
    offset += 4 + len;
    nalCount++;
  }
  return nalCount > 0 && offset === bytes.length;
}

/**
 * Normalise one encoded H.264 sample to 4-byte length-prefixed AVCC NAL units,
 * extracting SPS/PPS when the input is an Annex-B stream.
 *
 * `assumeAvcc` must be true when the encoder was configured with
 * `avc: { format: 'avc' }` (it then also supplies decoderConfig.description).
 * In that case the bytes are passed through untouched.
 *
 * Why this matters: an AVCC NAL of 256–511 bytes starts with the length bytes
 * `00 00 01 xx`, which is byte-identical to a 3-byte Annex-B start code. Sniffing
 * for start codes therefore rewrote every small (near-static) frame into an
 * invalid NAL and the tail of low-motion clips became undecodable. The format is
 * now decided structurally: a buffer that parses exactly as AVCC is AVCC.
 */
export function normalizeNalSample(rawBytes, { assumeAvcc = false } = {}) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  if (assumeAvcc || isLengthPrefixedAvcc(bytes)) {
    return { avccBytes: bytes, sps: null, pps: null };
  }

  const isAnnexB =
    (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1) ||
    (bytes.length >= 3 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1);

  if (!isAnnexB) {
    throw new Error('Encoded sample is neither length-prefixed AVCC nor Annex-B H.264');
  }

  // Split Annex-B stream into individual NAL units
  const nalUnits = [];
  let i = 0;
  let nalStart = -1;

  while (i < bytes.length) {
    let startCodeLen = 0;
    if (
      i + 3 < bytes.length &&
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 0 &&
      bytes[i + 3] === 1
    ) {
      startCodeLen = 4;
    } else if (
      i + 2 < bytes.length &&
      bytes[i] === 0 &&
      bytes[i + 1] === 0 &&
      bytes[i + 2] === 1
    ) {
      startCodeLen = 3;
    }

    if (startCodeLen > 0) {
      if (nalStart >= 0 && i > nalStart) {
        nalUnits.push(bytes.subarray(nalStart, i));
      }
      nalStart = i + startCodeLen;
      i += startCodeLen;
    } else {
      i++;
    }
  }
  if (nalStart >= 0 && nalStart < bytes.length) {
    nalUnits.push(bytes.subarray(nalStart));
  }

  let sps = null;
  let pps = null;
  const parts = [];

  for (const nal of nalUnits) {
    if (nal.length === 0) continue;
    const nalType = nal[0] & 0x1f;
    if (nalType === 7 && !sps) sps = nal;
    if (nalType === 8 && !pps) pps = nal;
    parts.push(u32(nal.byteLength), nal);
  }

  return {
    avccBytes: concatArrays(parts),
    sps,
    pps
  };
}

/**
 * Build an avcC configuration record from SPS & PPS NAL units when the encoder
 * did not supply decoderConfig.description (Annex-B output).
 * Never invent parameter sets: a made-up SPS produces a file that looks valid
 * but cannot be decoded.
 */
function buildAvcCFromSpsPps(sps, pps) {
  if (!sps || !pps || sps.byteLength < 4) {
    throw new Error(
      'Cannot mux MP4: the encoder supplied no decoder configuration and no SPS/PPS were found in the stream.'
    );
  }
  return concatArrays([
    new Uint8Array([
      1, // configurationVersion
      sps[1], // AVCProfileIndication
      sps[2], // profile_compatibility
      sps[3], // AVCLevelIndication
      0xff, // 4-byte NAL unit length indicator (0xfc | 3)
      0xe1 // 1 SPS (0xe0 | 1)
    ]),
    u16(sps.byteLength),
    sps,
    new Uint8Array([1]), // 1 PPS
    u16(pps.byteLength),
    pps
  ]);
}

function buildFtypBox() {
  return box(
    'ftyp',
    asciiBytes('isom'),
    u32(0x00000200),
    asciiBytes('isom'),
    asciiBytes('iso2'),
    asciiBytes('avc1'),
    asciiBytes('mp41')
  );
}

function buildMvhdBox(durationTicks) {
  const matrix = concatArrays([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000)
  ]);
  return fullBox(
    'mvhd',
    0,
    0,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(TIMESCALE),
    u32(durationTicks),
    u32(0x00010000), // rate 1.0
    u16(0x0100), // volume 1.0
    new Uint8Array(10), // reserved
    matrix,
    new Uint8Array(24), // pre_defined
    u32(2) // next_track_ID
  );
}

function buildTkhdBox(width, height, durationTicks) {
  const matrix = concatArrays([
    u32(0x00010000), u32(0), u32(0),
    u32(0), u32(0x00010000), u32(0),
    u32(0), u32(0), u32(0x40000000)
  ]);
  return fullBox(
    'tkhd',
    0,
    0x000003, // Track_enabled | Track_in_movie
    u32(0), // creation_time
    u32(0), // modification_time
    u32(1), // track_ID
    u32(0), // reserved
    u32(durationTicks),
    new Uint8Array(8), // reserved
    u16(0), // layer
    u16(0), // alternate_group
    u16(0), // volume (0 for video)
    u16(0), // reserved
    matrix,
    u32(width << 16), // 16.16 fixed-point width
    u32(height << 16) // 16.16 fixed-point height
  );
}

function buildMdhdBox(durationTicks) {
  return fullBox(
    'mdhd',
    0,
    0,
    u32(0), // creation_time
    u32(0), // modification_time
    u32(TIMESCALE),
    u32(durationTicks),
    u16(0x55c4), // 'und' language
    u16(0) // pre_defined
  );
}

function buildHdlrBox() {
  return fullBox(
    'hdlr',
    0,
    0,
    u32(0), // pre_defined
    asciiBytes('vide'),
    new Uint8Array(12), // reserved
    asciiBytes('FactShortsVideoHandler\0')
  );
}

function buildVmhdBox() {
  return fullBox('vmhd', 0, 0x000001, u16(0), u16(0), u16(0), u16(0));
}

function buildDinfBox() {
  const urlBox = fullBox('url ', 0, 0x000001);
  const drefBox = fullBox('dref', 0, 0, u32(1), urlBox);
  return box('dinf', drefBox);
}

/**
 * Colour tag for the sample entry. It must describe what the H.264 bitstream
 * actually carries: players that trust the container (QuickTime, iOS, most
 * editors) otherwise mis-map the levels. WebCodecs encoders emit limited-range
 * BT.709; the old hard-coded "full range" flag made those players show lifted,
 * milky blacks. Unsignalled values fall back to BT.709 limited, the H.264 default
 * for HD.
 */
export function colourInfoFromAvcC(avcCBytes) {
  const fallback = { primaries: 1, transfer: 1, matrix: 1, fullRange: false, source: 'default' };
  try {
    const spsNal = readSpsFromAvcC(avcCBytes);
    if (!spsNal) return fallback;
    const sps = parseH264Sps(spsNal);
    const known = (v) => (typeof v === 'number' && v !== 2 ? v : null);
    return {
      primaries: known(sps.colourPrimaries) ?? 1,
      transfer: known(sps.transferCharacteristics) ?? 1,
      matrix: known(sps.matrixCoefficients) ?? 1,
      fullRange: sps.fullRange === true,
      source: sps.fullRange === null ? 'default' : 'bitstream'
    };
  } catch (_) {
    return fallback;
  }
}

function buildStsdBox(width, height, avcCBytes) {
  const compressorName = new Uint8Array(32);
  const label = asciiBytes('\x0eFactShortsAVC1');
  compressorName.set(label.subarray(0, Math.min(32, label.length)), 0);

  const avcCBox = box('avcC', avcCBytes);
  const colour = colourInfoFromAvcC(avcCBytes);
  const colrBox = box(
    'colr',
    asciiBytes('nclx'),
    u16(colour.primaries),
    u16(colour.transfer),
    u16(colour.matrix),
    new Uint8Array([colour.fullRange ? 0x80 : 0x00])
  );

  const avc1Box = box(
    'avc1',
    new Uint8Array(6), // reserved
    u16(1), // data_reference_index
    u16(0), // pre_defined
    u16(0), // reserved
    new Uint8Array(12), // pre_defined
    u16(width),
    u16(height),
    u32(0x00480000), // horizresolution 72 dpi
    u32(0x00480000), // vertresolution 72 dpi
    u32(0), // reserved
    u16(1), // frame_count = 1
    compressorName,
    u16(0x0018), // depth = 24
    u16(0xffff), // pre_defined = -1
    avcCBox,
    colrBox
  );

  return fullBox('stsd', 0, 0, u32(1), avc1Box);
}

function buildSttsBox(sampleCount, sampleDeltaTicks) {
  return fullBox('stts', 0, 0, u32(1), u32(sampleCount), u32(sampleDeltaTicks));
}

function buildStssBox(keyframeNumbers) {
  const entries = keyframeNumbers.map((n) => u32(n));
  return fullBox('stss', 0, 0, u32(keyframeNumbers.length), ...entries);
}

function buildStscBox() {
  // 1 sample per chunk -> direct 1:1 mapping with stco offsets
  return fullBox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1));
}

function buildStszBox(sampleSizes) {
  const entries = sampleSizes.map((sz) => u32(sz));
  return fullBox('stsz', 0, 0, u32(0), u32(sampleSizes.length), ...entries);
}

function buildStcoBox(sampleOffsets) {
  const entries = sampleOffsets.map((off) => u32(off));
  return fullBox('stco', 0, 0, u32(sampleOffsets.length), ...entries);
}

function buildMoovBox({
  width,
  height,
  fps,
  avcCBytes,
  sampleSizes,
  sampleOffsets,
  keyframeNumbers
}) {
  const sampleCount = sampleSizes.length;
  const sampleDeltaTicks = Math.round(TIMESCALE / fps); // 30000 / 30 = 1000 ticks
  const durationTicks = sampleCount * sampleDeltaTicks;

  const stblBox = box(
    'stbl',
    buildStsdBox(width, height, avcCBytes),
    buildSttsBox(sampleCount, sampleDeltaTicks),
    buildStssBox(keyframeNumbers),
    buildStscBox(),
    buildStszBox(sampleSizes),
    buildStcoBox(sampleOffsets)
  );

  const minfBox = box('minf', buildVmhdBox(), buildDinfBox(), stblBox);
  const mdiaBox = box('mdia', buildMdhdBox(durationTicks), buildHdlrBox(), minfBox);
  const trakBox = box('trak', buildTkhdBox(width, height, durationTicks), mdiaBox);

  return box('moov', buildMvhdBox(durationTicks), trakBox);
}

/**
 * Multiplex encoded H.264 samples into a FastStart ISO-BMFF `.mp4` Uint8Array.
 *
 * @param {Object} params
 * @param {number} params.width - Video width (e.g. 1080 or 1920)
 * @param {number} params.height - Video height (e.g. 1920 or 1080)
 * @param {number} params.fps - Locked at 30
 * @param {Uint8Array|null} params.avcDescription - decoderConfig.description from WebCodecs
 * @param {Array<{data: Uint8Array, isKeyframe: boolean}>} params.samples - Encoded frame chunks
 * @returns {Uint8Array} Complete MP4 binary buffer
 */
export function muxH264SamplesToMp4({
  width,
  height,
  fps = 30,
  avcDescription = null,
  samples = []
}) {
  if (!samples.length) {
    throw new Error('Cannot mux MP4: zero encoded video samples provided.');
  }

  let detectedSps = null;
  let detectedPps = null;
  const normalizedPayloads = [];
  const sampleSizes = [];
  const keyframeNumbers = [];

  const hasDescription = Boolean(avcDescription && avcDescription.byteLength > 0);
  if (!samples[0].isKeyframe) {
    throw new Error('Cannot mux MP4: the first video sample is not a keyframe.');
  }

  for (let i = 0; i < samples.length; i++) {
    if (!samples[i].data || samples[i].data.byteLength === 0) {
      throw new Error(`Cannot mux MP4: video sample ${i + 1} of ${samples.length} is empty.`);
    }
    const { avccBytes, sps, pps } = normalizeNalSample(samples[i].data, { assumeAvcc: hasDescription });
    if (sps && !detectedSps) detectedSps = sps;
    if (pps && !detectedPps) detectedPps = pps;
    normalizedPayloads.push(avccBytes);
    sampleSizes.push(avccBytes.byteLength);
    if (samples[i].isKeyframe) {
      keyframeNumbers.push(i + 1); // 1-based sample number for stss
    }
  }

  const avcCBytes = hasDescription
    ? new Uint8Array(avcDescription)
    : buildAvcCFromSpsPps(detectedSps, detectedPps);

  const ftypBox = buildFtypBox();

  // Pass 1: Build dummy moov to measure exact header size before mdat payload
  const dummyOffsets = sampleSizes.map(() => 0);
  const dummyMoov = buildMoovBox({
    width,
    height,
    fps,
    avcCBytes,
    sampleSizes,
    sampleOffsets: dummyOffsets,
    keyframeNumbers
  });

  // mdat payload starts right after ftyp + moov + 8-byte mdat box header
  const mdatPayloadStart = ftypBox.byteLength + dummyMoov.byteLength + 8;

  const realOffsets = [];
  let runningOffset = mdatPayloadStart;
  for (const sz of sampleSizes) {
    realOffsets.push(runningOffset);
    runningOffset += sz;
  }

  // Pass 2: Build final moov with exact mdat byte offsets
  const moovBox = buildMoovBox({
    width,
    height,
    fps,
    avcCBytes,
    sampleSizes,
    sampleOffsets: realOffsets,
    keyframeNumbers
  });

  const mdatBox = box('mdat', ...normalizedPayloads);
  return concatArrays([ftypBox, moovBox, mdatBox]);
}

/**
 * Inspect an MP4 binary buffer and verify its ISO-BMFF boxes, resolution, frame count, and 30.000 FPS CFR.
 * Reads the real box tree and sample tables (see parseMp4Structure) rather than scanning for byte tags.
 * This checks the container only — decoding is verified separately by the quality inspector.
 */
export function inspectMp4Buffer(mp4Bytes) {
  const bytes = mp4Bytes instanceof Uint8Array ? mp4Bytes : new Uint8Array(mp4Bytes);
  const { structure, problems, samples, sps } = extractH264Samples(bytes);
  const video = structure.video;

  const sampleCount = video ? video.sampleSizes.length : 0;
  const uniformDelta = video && video.sttsEntries.length === 1 ? video.sttsEntries[0].delta : 0;
  const fps = video && uniformDelta > 0 ? Number((video.timescale / uniformDelta).toFixed(3)) : 0;
  const durationSec = video && video.timescale > 0 ? Number((video.durationTicks / video.timescale).toFixed(3)) : 0;
  const hasAvc1 = Boolean(video && (video.codecFourcc === 'avc1' || video.codecFourcc === 'avc3'));

  return {
    validMp4:
      structure.topBoxes.includes('ftyp') &&
      structure.topBoxes.includes('moov') &&
      structure.topBoxes.includes('mdat') &&
      hasAvc1 &&
      problems.length === 0 &&
      samples.length === sampleCount &&
      sampleCount > 0,
    fastStart: structure.fastStart,
    codec: hasAvc1 ? 'H.264 (avc1)' : video?.codecFourcc || 'unknown',
    width: video?.width || 0,
    height: video?.height || 0,
    fps,
    isConstant30Fps: fps === 30 && video.sttsEntries.length === 1,
    frameCount: sampleCount,
    durationSec,
    byteLength: bytes.byteLength,
    topBoxes: structure.topBoxes,
    keyframeCount: video?.keyframes ? video.keyframes.length : sampleCount,
    hasAudioTrack: structure.tracks.includes('soun'),
    colour: video?.colr || null,
    bitstreamFullRange: sps ? sps.fullRange : null,
    problems
  };
}

/* ============================================================================
   Structural MP4 demuxer + H.264 SPS reader
   Used by the quality inspector to decode a finished file back to frames,
   so a render is validated by actually decoding it — not by trusting that a
   file with the right box names exists.
   ============================================================================ */

const CONTAINER_BOXES = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'mvex', 'moof', 'traf']);

function fourcc(bytes, offset) {
  return String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
}

function readBoxes(bytes, view, start, end, depth = 0) {
  const boxes = [];
  let offset = start;
  while (offset + 8 <= end) {
    let size = view.getUint32(offset, false);
    const type = fourcc(bytes, offset + 4);
    let headerSize = 8;
    if (size === 1) {
      if (offset + 16 > end) break;
      size = Number(view.getBigUint64(offset + 8, false));
      headerSize = 16;
    } else if (size === 0) {
      size = end - offset;
    }
    if (size < headerSize || offset + size > end) {
      boxes.push({ type, offset, size, headerSize, truncated: true, children: [] });
      break;
    }
    const node = { type, offset, size, headerSize, truncated: false, children: [] };
    if (CONTAINER_BOXES.has(type) && depth < 8) {
      node.children = readBoxes(bytes, view, offset + headerSize, offset + size, depth + 1);
    }
    boxes.push(node);
    offset += size;
  }
  return boxes;
}

function findBox(boxes, pathParts) {
  let level = boxes;
  let node = null;
  for (const part of pathParts) {
    node = level.find((b) => b.type === part);
    if (!node) return null;
    level = node.children;
  }
  return node;
}

class BitReader {
  constructor(bytes) {
    this.bytes = bytes;
    this.pos = 0;
  }
  bit() {
    const byte = this.bytes[this.pos >> 3];
    if (byte === undefined) throw new Error('SPS bitstream ended unexpectedly');
    const v = (byte >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 32) throw new Error('Invalid Exp-Golomb code in SPS');
    }
    return zeros === 0 ? 0 : Math.pow(2, zeros) - 1 + this.bits(zeros);
  }
  se() {
    const k = this.ue();
    return k % 2 === 1 ? (k + 1) / 2 : -(k / 2);
  }
}

function stripEmulationPrevention(nal) {
  const out = [];
  for (let i = 0; i < nal.length; i++) {
    if (i >= 2 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    out.push(nal[i]);
  }
  return Uint8Array.from(out);
}

function skipScalingList(r, size) {
  let last = 8;
  let next = 8;
  for (let j = 0; j < size; j++) {
    if (next !== 0) next = (last + r.se() + 256) % 256;
    last = next === 0 ? last : next;
  }
}

function skipHrd(r) {
  const cpbCount = r.ue() + 1;
  r.bits(4);
  r.bits(4);
  for (let i = 0; i < cpbCount; i++) {
    r.ue();
    r.ue();
    r.bit();
  }
  r.bits(5);
  r.bits(5);
  r.bits(5);
  r.bits(5);
}

/**
 * Parse an H.264 SPS NAL unit: coded size, profile/level, colour signalling (VUI)
 * and frame-reordering depth. `null` fields mean "not signalled in the bitstream".
 */
export function parseH264Sps(spsNal) {
  const r = new BitReader(stripEmulationPrevention(spsNal.subarray(1)));
  const profileIdc = r.bits(8);
  const constraintFlags = r.bits(8);
  const levelIdc = r.bits(8);
  r.ue(); // seq_parameter_set_id

  let chromaFormatIdc = 1;
  if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) r.bit();
    r.ue();
    r.ue();
    r.bit();
    if (r.bit()) {
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (r.bit()) skipScalingList(r, i < 6 ? 16 : 64);
      }
    }
  }

  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) {
    r.ue();
  } else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const cycle = r.ue();
    for (let i = 0; i < cycle; i++) r.se();
  }
  const maxNumRefFrames = r.ue();
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  const mbWidth = r.ue() + 1;
  const mapUnitsHeight = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8_inference_flag

  let cropL = 0, cropR = 0, cropT = 0, cropB = 0;
  if (r.bit()) {
    cropL = r.ue();
    cropR = r.ue();
    cropT = r.ue();
    cropB = r.ue();
  }
  const cropUnitX = chromaFormatIdc === 0 || chromaFormatIdc === 3 ? 1 : 2;
  const cropUnitY = (chromaFormatIdc === 1 ? 2 : 1) * (2 - frameMbsOnly);
  const width = mbWidth * 16 - (cropL + cropR) * cropUnitX;
  const height = (2 - frameMbsOnly) * mapUnitsHeight * 16 - (cropT + cropB) * cropUnitY;

  const info = {
    profileIdc,
    constraintFlags,
    levelIdc,
    width,
    height,
    maxNumRefFrames,
    vuiPresent: false,
    fullRange: null,
    colourPrimaries: null,
    transferCharacteristics: null,
    matrixCoefficients: null,
    timingFps: null,
    maxNumReorderFrames: null
  };

  if (r.bit()) {
    info.vuiPresent = true;
    if (r.bit()) {
      if (r.bits(8) === 255) {
        r.bits(16);
        r.bits(16);
      }
    }
    if (r.bit()) r.bit();
    if (r.bit()) {
      r.bits(3);
      info.fullRange = r.bit() === 1;
      if (r.bit()) {
        info.colourPrimaries = r.bits(8);
        info.transferCharacteristics = r.bits(8);
        info.matrixCoefficients = r.bits(8);
      }
    }
    if (r.bit()) {
      r.ue();
      r.ue();
    }
    if (r.bit()) {
      const unitsInTick = r.bits(32);
      const timeScale = r.bits(32);
      r.bit();
      if (unitsInTick > 0) info.timingFps = timeScale / (2 * unitsInTick);
    }
    const nalHrd = r.bit();
    if (nalHrd) skipHrd(r);
    const vclHrd = r.bit();
    if (vclHrd) skipHrd(r);
    if (nalHrd || vclHrd) r.bit();
    r.bit(); // pic_struct_present_flag
    if (r.bit()) {
      r.bit();
      r.ue();
      r.ue();
      r.ue();
      r.ue();
      info.maxNumReorderFrames = r.ue();
      r.ue();
    }
  }
  return info;
}

/** Read the first SPS out of an avcC configuration record. */
export function readSpsFromAvcC(avcC) {
  if (!avcC || avcC.byteLength < 8) return null;
  const spsCount = avcC[5] & 0x1f;
  if (spsCount < 1) return null;
  const spsLen = (avcC[6] << 8) | avcC[7];
  if (8 + spsLen > avcC.byteLength) return null;
  return avcC.subarray(8, 8 + spsLen);
}

/**
 * Walk the box tree of an MP4 and return the video track's sample tables.
 * Throws with a specific message when the file is structurally unusable.
 */
export function parseMp4Structure(mp4Bytes) {
  const bytes = mp4Bytes instanceof Uint8Array ? mp4Bytes : new Uint8Array(mp4Bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = readBoxes(bytes, view, 0, bytes.byteLength);

  const structure = {
    byteLength: bytes.byteLength,
    topBoxes: top.map((b) => b.type),
    truncatedBox: top.find((b) => b.truncated)?.type || null,
    fastStart: false,
    fragmented: top.some((b) => b.type === 'moof'),
    tracks: [],
    video: null
  };

  const moov = top.find((b) => b.type === 'moov');
  const mdat = top.find((b) => b.type === 'mdat');
  structure.fastStart = Boolean(moov && mdat && moov.offset < mdat.offset);
  if (!moov) return structure;

  for (const trak of moov.children.filter((b) => b.type === 'trak')) {
    const hdlr = findBox(trak.children, ['mdia', 'hdlr']);
    const handler = hdlr ? fourcc(bytes, hdlr.offset + hdlr.headerSize + 8) : '????';
    structure.tracks.push(handler);
    if (handler !== 'vide' || structure.video) continue;

    const video = {
      width: 0, height: 0, timescale: 0, durationTicks: 0,
      codecFourcc: null, avcC: null, colr: null,
      sttsEntries: [], cttsEntries: [], keyframes: null,
      sampleSizes: [], sampleOffsets: [], mdatRange: null
    };

    const tkhd = findBox(trak.children, ['tkhd']);
    if (tkhd) {
      const body = tkhd.offset + tkhd.headerSize;
      const version = bytes[body];
      const dimsAt = body + (version === 1 ? 88 : 76);
      video.width = view.getUint32(dimsAt, false) >>> 16;
      video.height = view.getUint32(dimsAt + 4, false) >>> 16;
    }

    const mdhd = findBox(trak.children, ['mdia', 'mdhd']);
    if (mdhd) {
      const body = mdhd.offset + mdhd.headerSize;
      const version = bytes[body];
      if (version === 1) {
        video.timescale = view.getUint32(body + 20, false);
        video.durationTicks = Number(view.getBigUint64(body + 24, false));
      } else {
        video.timescale = view.getUint32(body + 12, false);
        video.durationTicks = view.getUint32(body + 16, false);
      }
    }

    const stbl = findBox(trak.children, ['mdia', 'minf', 'stbl']);
    const stblChild = (type) => (stbl ? stbl.children.find((b) => b.type === type) : null);

    const stsd = stblChild('stsd');
    if (stsd) {
      const entry = stsd.offset + stsd.headerSize + 8;
      if (entry + 8 <= stsd.offset + stsd.size) {
        const entrySize = view.getUint32(entry, false);
        video.codecFourcc = fourcc(bytes, entry + 4);
        // Visual sample entry: 8 header + 78 fixed bytes, then child boxes (avcC, colr, …)
        const children = readBoxes(bytes, view, entry + 86, Math.min(entry + entrySize, stsd.offset + stsd.size), 9);
        const avcCBox = children.find((b) => b.type === 'avcC');
        if (avcCBox) {
          video.avcC = bytes.subarray(avcCBox.offset + avcCBox.headerSize, avcCBox.offset + avcCBox.size);
        }
        const colrBox = children.find((b) => b.type === 'colr');
        if (colrBox) {
          const body = colrBox.offset + colrBox.headerSize;
          const kind = fourcc(bytes, body);
          if (kind === 'nclx' && colrBox.size >= colrBox.headerSize + 11) {
            video.colr = {
              kind,
              primaries: view.getUint16(body + 4, false),
              transfer: view.getUint16(body + 6, false),
              matrix: view.getUint16(body + 8, false),
              fullRange: (bytes[body + 10] & 0x80) !== 0
            };
          } else {
            video.colr = { kind };
          }
        }
      }
    }

    const readTable = (node, entryReader) => {
      if (!node) return [];
      const body = node.offset + node.headerSize;
      const count = view.getUint32(body + 4, false);
      const out = [];
      for (let i = 0; i < count; i++) out.push(entryReader(body + 8, i));
      return out;
    };

    video.sttsEntries = readTable(stblChild('stts'), (base, i) => ({
      count: view.getUint32(base + i * 8, false),
      delta: view.getUint32(base + i * 8 + 4, false)
    }));
    video.cttsEntries = readTable(stblChild('ctts'), (base, i) => ({
      count: view.getUint32(base + i * 8, false),
      offset: view.getInt32(base + i * 8 + 4, false)
    }));
    const stss = stblChild('stss');
    video.keyframes = stss ? readTable(stss, (base, i) => view.getUint32(base + i * 4, false)) : null;

    const stsz = stblChild('stsz');
    if (stsz) {
      const body = stsz.offset + stsz.headerSize;
      const uniform = view.getUint32(body + 4, false);
      const count = view.getUint32(body + 8, false);
      for (let i = 0; i < count; i++) {
        video.sampleSizes.push(uniform || view.getUint32(body + 12 + i * 4, false));
      }
    }

    const stscEntries = readTable(stblChild('stsc'), (base, i) => ({
      firstChunk: view.getUint32(base + i * 12, false),
      samplesPerChunk: view.getUint32(base + i * 12 + 4, false)
    }));
    const stco = stblChild('stco');
    const co64 = stblChild('co64');
    const chunkOffsets = stco
      ? readTable(stco, (base, i) => view.getUint32(base + i * 4, false))
      : readTable(co64, (base, i) => Number(view.getBigUint64(base + i * 8, false)));

    let sampleIndex = 0;
    for (let c = 0; c < chunkOffsets.length && sampleIndex < video.sampleSizes.length; c++) {
      const chunkNumber = c + 1;
      let perChunk = 1;
      for (const e of stscEntries) {
        if (e.firstChunk <= chunkNumber) perChunk = e.samplesPerChunk;
      }
      let cursor = chunkOffsets[c];
      for (let s = 0; s < perChunk && sampleIndex < video.sampleSizes.length; s++) {
        video.sampleOffsets.push(cursor);
        cursor += video.sampleSizes[sampleIndex];
        sampleIndex++;
      }
    }

    if (mdat) {
      video.mdatRange = { start: mdat.offset + mdat.headerSize, end: mdat.offset + mdat.size };
    }
    structure.video = video;
  }

  return structure;
}

/**
 * Extract the video track as decoder-ready H.264 samples (AVCC, decode order)
 * with presentation timestamps in microseconds. Also returns every structural
 * problem found, so the caller can fail loudly instead of decoding garbage.
 */
export function extractH264Samples(mp4Bytes) {
  const bytes = mp4Bytes instanceof Uint8Array ? mp4Bytes : new Uint8Array(mp4Bytes);
  const structure = parseMp4Structure(bytes);
  const problems = [];
  const video = structure.video;

  if (structure.truncatedBox) problems.push(`Truncated or malformed '${structure.truncatedBox}' box (incomplete write?)`);
  if (!structure.topBoxes.includes('ftyp')) problems.push('Missing ftyp box');
  if (!structure.topBoxes.includes('moov')) problems.push('Missing moov box (file was not finalized)');
  if (!structure.topBoxes.includes('mdat') && !structure.fragmented) problems.push('Missing mdat box');
  if (!video) {
    problems.push('No video track found');
    return { structure, problems, samples: [], sps: null, config: null };
  }
  if (video.codecFourcc !== 'avc1' && video.codecFourcc !== 'avc3') {
    problems.push(`Video codec is '${video.codecFourcc}', expected H.264 (avc1)`);
  }
  if (!video.avcC) problems.push('Missing avcC decoder configuration');
  if (video.sampleOffsets.length !== video.sampleSizes.length) {
    problems.push(`Sample tables disagree: ${video.sampleSizes.length} sizes vs ${video.sampleOffsets.length} offsets`);
  }

  const samples = [];
  const count = Math.min(video.sampleSizes.length, video.sampleOffsets.length);
  const keyframeSet = video.keyframes ? new Set(video.keyframes) : null;

  // Decode timestamps from stts, composition offsets from ctts.
  const dts = [];
  let tick = 0;
  for (const e of video.sttsEntries) {
    for (let i = 0; i < e.count; i++) {
      dts.push({ tick, delta: e.delta });
      tick += e.delta;
    }
  }
  const cttsOffsets = [];
  for (const e of video.cttsEntries) {
    for (let i = 0; i < e.count; i++) cttsOffsets.push(e.offset);
  }
  if (dts.length !== count) {
    problems.push(`Timestamp table covers ${dts.length} samples but the track has ${count}`);
  }

  let outOfBounds = 0;
  for (let i = 0; i < count; i++) {
    const offset = video.sampleOffsets[i];
    const size = video.sampleSizes[i];
    const inFile = offset + size <= bytes.byteLength;
    const inMdat = !video.mdatRange || (offset >= video.mdatRange.start && offset + size <= video.mdatRange.end);
    if (!inFile || !inMdat || size === 0) {
      outOfBounds++;
      continue;
    }
    const t = dts[i] || { tick: i, delta: 0 };
    const ts = video.timescale || 1;
    samples.push({
      index: i,
      data: bytes.subarray(offset, offset + size),
      isKeyframe: keyframeSet ? keyframeSet.has(i + 1) : true,
      timestampUs: Math.round(((t.tick + (cttsOffsets[i] || 0)) * 1_000_000) / ts),
      durationUs: Math.round((t.delta * 1_000_000) / ts)
    });
  }
  if (outOfBounds > 0) {
    problems.push(`${outOfBounds} sample(s) point outside the media data (corrupt offsets or truncated file)`);
  }
  if (samples.length > 0 && !samples[0].isKeyframe) problems.push('First sample is not a keyframe');

  let sps = null;
  try {
    const spsNal = readSpsFromAvcC(video.avcC);
    if (spsNal) sps = parseH264Sps(spsNal);
  } catch (err) {
    problems.push(`Could not parse SPS: ${err.message}`);
  }
  if (sps && (sps.width !== video.width || sps.height !== video.height)) {
    problems.push(`Container says ${video.width}×${video.height} but the bitstream is ${sps.width}×${sps.height}`);
  }

  let config = null;
  if (video.avcC && video.avcC.byteLength >= 4) {
    const hex = (n) => n.toString(16).padStart(2, '0');
    config = {
      codec: `avc1.${hex(video.avcC[1])}${hex(video.avcC[2])}${hex(video.avcC[3])}`,
      codedWidth: sps?.width || video.width,
      codedHeight: sps?.height || video.height,
      description: video.avcC
    };
  }

  return { structure, problems, samples, sps, config };
}

/**
 * Decode an H.264 MP4 back to frames with WebCodecs (browser only) and report
 * exactly what came out. This is the ground truth for "did the render work":
 * a file is only trusted once every frame has been decoded.
 *
 * `onFrame(videoFrame, index)` may read pixels; the frame is closed afterwards.
 * Never throws for a bad file — problems are returned in `errors`.
 */
export async function decodeH264Mp4(mp4Bytes, { onFrame = null } = {}) {
  const extracted = extractH264Samples(mp4Bytes);
  const result = {
    structure: extracted.structure,
    sps: extracted.sps,
    expectedFrames: extracted.structure.video ? extracted.structure.video.sampleSizes.length : 0,
    decodedFrames: 0,
    timestampsUs: [],
    errors: [...extracted.problems],
    decoderAvailable: typeof VideoDecoder !== 'undefined'
  };
  if (!result.decoderAvailable) {
    result.errors.push('VideoDecoder (WebCodecs) is not available in this environment — decode not verified');
    return result;
  }
  if (!extracted.config || extracted.samples.length === 0) return result;

  let decoderError = null;
  let callbackError = null;
  const decoder = new VideoDecoder({
    output: (frame) => {
      try {
        result.timestampsUs.push(frame.timestamp);
        if (onFrame && !callbackError) onFrame(frame, result.decodedFrames);
      } catch (err) {
        callbackError = err;
      } finally {
        result.decodedFrames++;
        frame.close();
      }
    },
    error: (err) => {
      decoderError = err;
    }
  });

  try {
    decoder.configure({
      codec: extracted.config.codec,
      codedWidth: extracted.config.codedWidth,
      codedHeight: extracted.config.codedHeight,
      description: extracted.config.description
    });
    for (const sample of extracted.samples) {
      if (decoderError || decoder.state !== 'configured') break;
      decoder.decode(
        new EncodedVideoChunk({
          type: sample.isKeyframe ? 'key' : 'delta',
          timestamp: sample.timestampUs,
          duration: sample.durationUs,
          data: sample.data
        })
      );
      // Keep the decode queue bounded so memory stays flat on long clips.
      while (decoder.decodeQueueSize > 12 && !decoderError && decoder.state === 'configured') {
        await new Promise((r) => setTimeout(r, 2));
      }
    }
    if (decoder.state === 'configured') await decoder.flush();
  } catch (err) {
    if (!decoderError) decoderError = err;
  } finally {
    if (decoder.state !== 'closed') {
      try { decoder.close(); } catch (_) { /* already closed by an error */ }
    }
  }

  if (decoderError) {
    result.errors.push(
      `Decoder failed after ${result.decodedFrames} of ${result.expectedFrames} frames: ${decoderError.message || decoderError}`
    );
  }
  if (callbackError) result.errors.push(`Frame analysis failed: ${callbackError.message || callbackError}`);
  if (!decoderError && result.decodedFrames !== result.expectedFrames) {
    result.errors.push(`Decoded ${result.decodedFrames} frames but the file declares ${result.expectedFrames}`);
  }
  for (let i = 1; i < result.timestampsUs.length; i++) {
    if (result.timestampsUs[i] <= result.timestampsUs[i - 1]) {
      result.errors.push(`Frame timestamps are not strictly increasing at frame ${i + 1}`);
      break;
    }
  }
  return result;
}
