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
 * Detect if a buffer uses Annex-B start codes (00 00 00 01 or 00 00 01)
 * and convert to 4-byte length-prefixed AVCC NAL units, extracting SPS/PPS if needed.
 */
export function normalizeNalSample(rawBytes) {
  const bytes = rawBytes instanceof Uint8Array ? rawBytes : new Uint8Array(rawBytes);
  const isAnnexB =
    (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 1) ||
    (bytes.length >= 3 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1);

  if (!isAnnexB) {
    return { avccBytes: bytes, sps: null, pps: null };
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
 * Build an avcC configuration record from SPS & PPS NAL units if decoderConfig.description wasn't supplied
 */
function buildAvcCFromSpsPps(sps, pps) {
  const spsData = sps || new Uint8Array([0x67, 0x64, 0x00, 0x28, 0xac, 0xd9, 0x40]);
  const ppsData = pps || new Uint8Array([0x68, 0xeb, 0xe3, 0xcb, 0x22, 0xc0]);
  const profileIdc = spsData[1] || 0x64;
  const profileCompat = spsData[2] || 0x00;
  const levelIdc = spsData[3] || 0x28;

  return concatArrays([
    new Uint8Array([
      1, // configurationVersion
      profileIdc,
      profileCompat,
      levelIdc,
      0xff, // 4-byte NAL unit length indicator (0xfc | 3)
      0xe1 // 1 SPS (0xe0 | 1)
    ]),
    u16(spsData.byteLength),
    spsData,
    new Uint8Array([1]), // 1 PPS
    u16(ppsData.byteLength),
    ppsData
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

function buildStsdBox(width, height, avcCBytes) {
  const compressorName = new Uint8Array(32);
  const label = asciiBytes('\x0eFactShortsAVC1');
  compressorName.set(label.subarray(0, Math.min(32, label.length)), 0);

  const avcCBox = box('avcC', avcCBytes);
  // BT.709 color profile atom so video editors match canvas sRGB accurately
  const colrBox = box(
    'colr',
    asciiBytes('nclx'),
    u16(1), // primaries BT.709
    u16(1), // transfer BT.709
    u16(1), // matrix BT.709
    new Uint8Array([0x80]) // full range flag
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

  for (let i = 0; i < samples.length; i++) {
    const { avccBytes, sps, pps } = normalizeNalSample(samples[i].data);
    if (sps && !detectedSps) detectedSps = sps;
    if (pps && !detectedPps) detectedPps = pps;
    normalizedPayloads.push(avccBytes);
    sampleSizes.push(avccBytes.byteLength);
    if (samples[i].isKeyframe || i === 0) {
      keyframeNumbers.push(i + 1); // 1-based sample number for stss
    }
  }

  const avcCBytes =
    avcDescription && avcDescription.byteLength > 0
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
 */
export function inspectMp4Buffer(mp4Bytes) {
  const bytes = mp4Bytes instanceof Uint8Array ? mp4Bytes : new Uint8Array(mp4Bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const topBoxes = [];
  let offset = 0;
  while (offset + 8 <= bytes.byteLength) {
    const size = view.getUint32(offset, false);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7]
    );
    topBoxes.push({ type, size, offset });
    if (size < 8) break;
    offset += size;
  }

  // Scan for tkhd (width/height), mdhd (timescale/duration), stts (sampleCount/sampleDelta), stsz (frame count)
  let width = 0;
  let height = 0;
  let timescale = 0;
  let durationTicks = 0;
  let sampleCount = 0;
  let sampleDelta = 0;
  let hasAvc1 = false;

  for (let i = 0; i + 8 < bytes.byteLength; i++) {
    const tag =
      String.fromCharCode(bytes[i + 4], bytes[i + 5], bytes[i + 6], bytes[i + 7]);

    if (tag === 'avc1') {
      hasAvc1 = true;
    } else if (tag === 'tkhd' && i + 92 <= bytes.byteLength) {
      const boxSize = view.getUint32(i, false);
      if (boxSize === 92) {
        width = view.getUint32(i + 84, false) >>> 16;
        height = view.getUint32(i + 88, false) >>> 16;
      }
    } else if (tag === 'mdhd' && i + 32 <= bytes.byteLength) {
      const boxSize = view.getUint32(i, false);
      if (boxSize === 32) {
        timescale = view.getUint32(i + 20, false);
        durationTicks = view.getUint32(i + 24, false);
      }
    } else if (tag === 'stts' && i + 24 <= bytes.byteLength) {
      const boxSize = view.getUint32(i, false);
      if (boxSize === 24 && view.getUint32(i + 12, false) === 1) {
        sampleCount = view.getUint32(i + 16, false);
        sampleDelta = view.getUint32(i + 20, false);
      }
    }
  }

  const fps = sampleDelta > 0 ? Number((timescale / sampleDelta).toFixed(3)) : 0;
  const durationSec = timescale > 0 ? Number((durationTicks / timescale).toFixed(2)) : 0;

  return {
    validMp4:
      topBoxes.some((b) => b.type === 'ftyp') &&
      topBoxes.some((b) => b.type === 'moov') &&
      topBoxes.some((b) => b.type === 'mdat') &&
      hasAvc1,
    fastStart:
      topBoxes.findIndex((b) => b.type === 'moov') <
      topBoxes.findIndex((b) => b.type === 'mdat'),
    codec: hasAvc1 ? 'H.264 (avc1)' : 'unknown',
    width,
    height,
    fps,
    isConstant30Fps: fps === 30,
    frameCount: sampleCount,
    durationSec,
    byteLength: bytes.byteLength,
    topBoxes: topBoxes.map((b) => b.type)
  };
}
