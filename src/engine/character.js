// Procedural character animation — real, visible subject movement.
// Plain ES Module — shared by live preview AND frame-by-frame video export.
//
// Why this exists: a single flat image can only be moved by the camera.
// Camera zoom/pan alone reads as a slideshow, not as animation. So this
// module draws a flat-2D cartoon presenter *in front of* the image and
// animates them like a character: they walk in, point at the subject,
// talk/gesture, and react — every frame is a pure function of `t`, so
// preview === export frame-for-frame at 30 FPS.
//
// Honest limit: this is a drawn presenter, not the people/objects inside
// the source image. A flat PNG cannot articulate its own limbs. If you
// want *your* character to move, upload it as a transparent-PNG cutout
// (see renderCharacterCutout): the cutout walks, bobs, leans and hops
// as its own layer, independent of the background camera.

export const CHARACTER_ACTIONS = [
  {
    id: 'walk-point',
    name: 'Walk in + Point',
    description: 'Walks in from the side, plants feet, points at the subject and talks.'
  },
  {
    id: 'explain',
    name: 'Explain + Gesture',
    description: 'Walks in, then talks with both hands — open-palm explaining gestures.'
  },
  {
    id: 'wave-react',
    name: 'Wave + React',
    description: 'Walks in waving, then a big surprised reaction at the payoff.'
  }
];

export const CHARACTER_ACTION_IDS = CHARACTER_ACTIONS.map((a) => a.id);

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
function smoothstep(x) {
  const c = clamp01(x);
  return c * c * (3 - 2 * c);
}
function easeOutCubic(x) {
  const c = clamp01(x);
  return 1 - Math.pow(1 - c, 3);
}
function easeInOutCubic(x) {
  const c = clamp01(x);
  return c < 0.5 ? 4 * c * c * c : 1 - Math.pow(-2 * c + 2, 3) / 2;
}
// Damped spring settle after a landing: oscillates once and decays.
// `dt` = seconds since the landing, `freq` in Hz.
function springSettle(dt, freq = 6) {
  if (dt < 0) return 0;
  return Math.sin(dt * Math.PI * 2 * freq) * Math.exp(-dt * 4.5);
}
// Layered, non-mechanical oscillation: two sines so the motion never
// repeats exactly every cycle (breathing, sway, talk).
function layeredSine(t, f1, f2, a1 = 1, a2 = 0.45, phase = 0) {
  return a1 * Math.sin(t * Math.PI * 2 * f1 + phase) + a2 * Math.sin(t * Math.PI * 2 * f2 + phase * 1.7);
}

/**
 * Pure pose math — no canvas needed, so it is unit-testable in Node.
 * Returns everything renderCharacter needs for one frame at time `t`.
 */
export function getCharacterPose(t, {
  duration = 4,
  width = 1080,
  height = 1920,
  action = 'walk-point',
  seed = 1,
  focusX = 0.5,
  focusY = 0.42
} = {}) {
  const progress = clamp01(t / Math.max(0.1, duration));
  const enterEnd = 0.34; // walk-in finishes at 34% of the clip — a 0.84s walk-in was a run, not a walk
  const pointEnd = 0.74; // pointing/explaining ends at 74%
  const phase = progress < enterEnd ? 'enter' : progress < pointEnd ? 'point' : 'react';

  // Presenter stands to the side of the subject and points across at it,
  // so pointing actually means something. If the subject is on the right,
  // the presenter stands on the left, and vice versa.
  const standSide = focusX >= 0.5 ? 0.36 : 0.64; // far enough in that a raised left hand stays in frame
  const walkFromX = focusX >= 0.5 ? -0.08 : 1.08; // just off the edge, not a full frame away — a 560px sprint in 1s read as a run, and he was invisible for the first half-second
  // Natural walk-in: smoothstep (slow start, slow stop — a real person
  // does not arrive at full speed and halt instantly) plus a small
  // damped settle bounce in the first 0.4s after planting the feet.
  // smoothstep, not cubic ease-in-out: cubic peaks at 3x average speed
  // (a mid-walk dash), smoothstep peaks at 1.5x — a relaxed walk.
  const walkIn = smoothstep(progress / enterEnd);
  const enterT = enterEnd * duration;
  const settleX = phase === 'enter' ? 0 : springSettle(t - enterT, 3.2) * width * 0.012;
  const anchorX = width * (walkFromX + (standSide - walkFromX) * walkIn) + settleX;
  // Small idle sway once planted, layered so it never looks looped.
  const swayX = phase === 'enter' ? 0 : layeredSine(t, 0.22, 0.37, 1, 0.5, seed) * width * 0.003;

  const feetY = height * 0.74;
  const charH = height * 0.42;
  const scale = charH / 420; // local drawing units: character is 420 tall

  // Walk cycle: ~1.7 steps/sec (a relaxed walk, not a march), legs swing
  // on arcs and the swinging foot lifts — see drawLeg knee bend.
  const walkFreq = 1.7;
  const walkCycle = Math.sin(t * Math.PI * 2 * walkFreq);
  const walkCycle2 = Math.sin(t * Math.PI * 2 * walkFreq + Math.PI);
  const legAmp = phase === 'enter' ? 0.55 : 0.05;
  const legL = walkCycle * legAmp;
  const legR = walkCycle2 * legAmp;
  // Foot lift: 0 when planted, 1 at mid-swing — used by drawLeg to lift
  // the foot along an arc instead of dragging it along the ground.
  const footLiftL = phase === 'enter' ? Math.max(0, Math.sin(t * Math.PI * 2 * walkFreq + Math.PI / 2)) : 0;
  const footLiftR = phase === 'enter' ? Math.max(0, Math.sin(t * Math.PI * 2 * walkFreq + Math.PI * 1.5)) : 0;
  // Vertical bob: smooth double-bump per step (no |cos| cusp — a real
  // body rises and falls smoothly), plus a hop on react.
  const walkBob = phase === 'enter'
    ? (0.5 - 0.5 * Math.cos(t * Math.PI * 2 * walkFreq * 2)) * 9 * scale
    : 0;
  // React hop: crouch first (anticipation), then jump, then land + settle.
  const reactT = (progress - pointEnd) / (1 - pointEnd);
  const reactHop = phase === 'react'
    ? Math.max(0, Math.sin(clamp01(reactT) * Math.PI)) * 26 * scale
    : 0;
  const reactCrouch = phase === 'react' && reactT < 0.12 ? -6 * scale * (1 - reactT / 0.12) : 0;
  const bobY = walkBob + reactHop + reactCrouch;
  // Squash & stretch: squash on walk landing and on hop landing, then
  // spring back. scaleY < 1 = squash, > 1 = stretch.
  const squashWalk = phase !== 'enter' ? springSettle(t - enterT, 6) * 0.05 : 0;
  const squashHop = phase === 'react' && reactT > 0.85
    ? springSettle((reactT - 0.85) * duration * 0.28, 6) * 0.06
    : 0;
  const squashY = 1 - squashWalk - squashHop;
  const squashX = 1 + (squashWalk + squashHop) * 0.6;
  // Breathing: layered, slow — chest rises/falls, never a perfect loop.
  const breathe = phase === 'enter' ? 0 : layeredSine(t, 0.45, 0.83, 0.008, 0.004, seed);

  // Blink: ~0.12s closed every ~2.7s, deterministic from seed.
  const blinkCycle = (t + seed * 0.7) % 2.7;
  const blink = blinkCycle < 0.12
    ? 0.12 + 0.88 * smoothstep(Math.abs(blinkCycle - 0.06) / 0.06)
    : 1;

  // Mouth: talking is syllables with pauses, not a metronome — layered
  // sines gated by a slow envelope so it opens in bursts and rests.
  const talkRaw = layeredSine(t, 3.1, 5.7, 0.6, 0.4, seed);
  const talkEnv = 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 0.7 + seed * 2);
  const talk = clamp01(0.35 + talkRaw * 0.45) * (0.4 + 0.6 * talkEnv);
  const mouthOpen = phase === 'react' ? 0.95 : phase === 'point' ? 0.2 + 0.7 * talk : 0.3;

  // Head & torso: follow-through — the head lags the torso by ~0.08s and
  // the torso lags the hips, so the body moves like a chain, not a block.
  // (Implemented as phase-shifted sines + a lagged lean.)
  const torsoLeanBase = phase === 'enter' ? 0.09 : phase === 'point' ? 0.05 : -0.08;
  const torsoLean = torsoLeanBase + layeredSine(t - 0.06, 0.5, 0.9, 0.012, 0.006, seed);
  const headTiltBase = phase === 'enter'
    ? 0.05
    : phase === 'point'
      ? (focusX >= 0.5 ? 0.10 : -0.10)
      : -0.12;
  const headTilt = headTiltBase + layeredSine(t - 0.12, 0.6, 1.1, 0.02, 0.01, seed + 1);
  const headBob = layeredSine(t, 0.28, 0.5, 0.02, 0.01, seed);
  // Secondary motion: hair tuft and shirt hem trail the head/torso.
  const hairSway = layeredSine(t - 0.18, 0.9, 1.6, 0.10, 0.06, seed + 2);
  const hemSway = layeredSine(t - 0.10, 0.7, 1.3, 0.05, 0.03, seed + 3);

  // --- Arms: screen-space directions (angle from +x axis, y down) ---
  // Shoulder screen position (approx, before bob/lean — render recomputes).
  const shoulderY = feetY - bobY - 320 * scale;
  const shoulderRX = anchorX + swayX + 52 * scale;
  const shoulderLX = anchorX + swayX - 52 * scale;
  const focusSX = width * focusX;
  const focusSY = height * focusY;
  const pointAngleR = Math.atan2(focusSY - shoulderY, focusSX - shoulderRX);
  const pointAngleL = Math.atan2(focusSY - shoulderY, focusSX - shoulderLX);

  let armR, armL;
  if (phase === 'enter') {
    // Arms swing opposite the legs while walking.
    armR = { upperAngle: Math.PI / 2 - walkCycle * 0.5, elbowBend: 0.35 };
    armL = { upperAngle: Math.PI / 2 - walkCycle2 * 0.5, elbowBend: 0.35 };
  } else if (action === 'wave-react' && phase === 'point') {
    // Wave with the right hand, left hand on hip.
    const wave = Math.sin(t * Math.PI * 2 * 3.0) * 0.45;
    armR = { upperAngle: -Math.PI / 2 + wave * 0.4, elbowBend: 0.5 + wave * 0.3 };
    armL = { upperAngle: Math.PI / 2 + 0.9, elbowBend: 1.5 };
  } else if (action === 'explain') {
    // Both hands up, open-palm, moving with the talk rhythm.
    const g = Math.sin(t * Math.PI * 2 * 1.6) * 0.35;
    armR = { upperAngle: -0.5 + g, elbowBend: 0.7 };
    armL = { upperAngle: Math.PI + 0.5 - g, elbowBend: 0.7 };
  } else if (phase === 'react') {
    // Both arms up in surprise.
    armR = { upperAngle: -1.15, elbowBend: 0.25 };
    armL = { upperAngle: Math.PI + 1.15, elbowBend: 0.25 };
  } else {
    // walk-point default: right arm points at the subject, left gestures.
    // Anticipation: in the last 0.25s of the walk-in the pointing arm
    // winds back (down/back) before it launches — then it overshoots
    // the point slightly and settles, instead of snapping straight there.
    const g = layeredSine(t, 0.8, 1.4, 0.18, 0.08, seed);
    const sinceEnter = t - enterT;
    const windBack = phase === 'point' && sinceEnter < 0.25
      ? Math.sin((sinceEnter / 0.25) * Math.PI) * 0.45
      : 0;
    const overshoot = phase === 'point' && sinceEnter >= 0.25 && sinceEnter < 0.7
      ? springSettle(sinceEnter - 0.25, 5) * 0.18
      : 0;
    // Blend from the walking swing into the point over ~0.2s so the arm
    // does not teleport at the phase boundary.
    const blend = phase === 'point' ? smoothstep(sinceEnter / 0.2) : 0;
    const walkArmR = Math.PI / 2 - walkCycle * 0.5;
    const pointArmR = pointAngleR - windBack + overshoot;
    armR = {
      upperAngle: walkArmR + (pointArmR - walkArmR) * blend,
      elbowBend: 0.35 + (0.12 - 0.35) * blend
    };
    armL = { upperAngle: 2.3 + g, elbowBend: 1.1 };
  }
  // Keep the unused variable meaningful for readers: left point angle is
  // available if a future action points with the left arm.
  void pointAngleL;

  return {
    t, progress, phase, action,
    anchorX: anchorX + swayX,
    feetY, charH, scale,
    bobY, breathe, legL, legR, footLiftL, footLiftR,
    squashY, squashX, hairSway, hemSway,
    blink, mouthOpen, headTilt, headBob, torsoLean,
    armR, armL,
    standSide, focusX, focusY
  };
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.rect(x, y, w, h);
  }
}

/**
 * Draw the procedural presenter for one frame. `ctx` is the 1080p+ canvas.
 * All motion comes from getCharacterPose(t, …) — deterministic at 30 FPS.
 */
export function renderCharacter(ctx, opts = {}) {
  const pose = getCharacterPose(opts.t ?? 0, opts);
  const { width, height } = opts;
  const s = pose.scale;
  const cx = pose.anchorX;
  const feetY = pose.feetY - pose.bobY;

  const SKIN = '#f2c29b';
  const SKIN_DARK = '#d9a06f';
  const HAIR = '#2b2118';
  const SHIRT = '#ff6b35';
  const SHIRT_DARK = '#e04e1a';
  const PANTS = '#2f3a4a';
  const SHOE = '#1d2330';
  const OUTLINE = '#191411';

  ctx.save();

  // Ground shadow — shrinks/fades when the character hops.
  const hopK = pose.bobY / (26 * s + 1);
  ctx.fillStyle = `rgba(0, 0, 0, ${(0.32 - hopK * 0.14).toFixed(3)})`;
  ctx.beginPath();
  ctx.ellipse(cx, feetY + 12 * s, 95 * s * (1 - hopK * 0.25), 16 * s, 0, 0, Math.PI * 2);
  ctx.fill();

  // --- Legs (local frame, origin at feet centre, y up) ---
  const hipY = feetY - 180 * s;
  const drawLeg = (hipX, angle, footLift = 0) => {
    const thigh = 92 * s;
    const shin = 92 * s;
    // Canvas y grows downwards: a leg hanging down goes to hipY + cos * len.
    // (An earlier version used hipY - cos, which drew the legs up into the
    // torso and left the character floating with no visible legs.)
    const kneeX = hipX + Math.sin(angle) * thigh;
    const kneeY = hipY + Math.cos(angle) * thigh;
    // The swinging foot lifts along an arc (knee bends more + foot rises)
    // instead of dragging along the ground.
    const kneeBend = 0.35 + Math.max(0, Math.sin(angle)) * 0.25 + footLift * 0.45;
    const footX = kneeX + Math.sin(angle + kneeBend) * shin;
    const footY = kneeY + Math.cos(angle + kneeBend) * shin - footLift * 55 * s;
    ctx.strokeStyle = PANTS;
    ctx.lineWidth = 26 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(hipX, hipY);
    ctx.lineTo(kneeX, kneeY);
    ctx.lineTo(footX, Math.min(footY, feetY));
    ctx.stroke();
    // Shoe
    ctx.fillStyle = SHOE;
    ctx.beginPath();
    ctx.ellipse(footX + 6 * s, Math.min(footY, feetY) - 2 * s, 22 * s, 10 * s, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  drawLeg(cx - 20 * s, pose.legL, pose.footLiftL);
  drawLeg(cx + 20 * s, pose.legR, pose.footLiftR);

  // --- Torso (breathing + lean) ---
  ctx.save();
  ctx.translate(cx, hipY);
  ctx.rotate(pose.torsoLean);
  // Squash & stretch: the torso compresses on landing and stretches on
  // the hop, with breathing layered on top.
  ctx.scale(pose.squashX, pose.squashY * (1 + pose.breathe));
  ctx.fillStyle = SHIRT;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3 * s;
  roundRectPath(ctx, -58 * s, -150 * s, 116 * s, 158 * s, 34 * s);
  ctx.fill();
  ctx.stroke();
  // Shirt shading + hem (hem trails the torso — secondary motion)
  ctx.fillStyle = SHIRT_DARK;
  ctx.save();
  ctx.translate(pose.hemSway * 14 * s, 0);
  ctx.fillRect(-58 * s, -22 * s, 116 * s, 18 * s);
  ctx.restore();
  ctx.fillStyle = '#fff7ed';
  ctx.beginPath();
  ctx.moveTo(-18 * s, -150 * s);
  ctx.lineTo(0, -128 * s);
  ctx.lineTo(18 * s, -150 * s);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // --- Head ---
  const headCX = cx + Math.sin(pose.headTilt) * 60 * s;
  const headCY = feetY - 368 * s + Math.sin(pose.headBob) * 3 * s;
  const headR = 52 * s;
  ctx.save();
  ctx.translate(headCX, headCY);
  ctx.rotate(pose.headTilt);
  // Face
  ctx.fillStyle = SKIN;
  ctx.strokeStyle = OUTLINE;
  ctx.lineWidth = 3 * s;
  ctx.beginPath();
  ctx.arc(0, 0, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  // Hair: cap + side sweep
  ctx.fillStyle = HAIR;
  ctx.beginPath();
  ctx.arc(0, -8 * s, headR + 2 * s, Math.PI * 1.02, Math.PI * 1.98);
  ctx.closePath();
  ctx.fill();
  ctx.beginPath();
  ctx.ellipse(-headR * 0.55, -headR * 0.55, headR * 0.5, headR * 0.32, -0.5 + pose.hairSway * 0.4, 0, Math.PI * 2);
  ctx.fill();
  // A small tuft that trails the head — the clearest secondary motion.
  ctx.beginPath();
  ctx.ellipse(headR * 0.35, -headR * 0.95, headR * 0.22, headR * 0.12, pose.hairSway, 0, Math.PI * 2);
  ctx.fill();
  // Eyes (blink scales the eye height)
  const eyeY = -6 * s;
  const eyeDX = 20 * s;
  const eyeOpen = Math.max(0.08, pose.blink);
  for (const side of [-1, 1]) {
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(side * eyeDX, eyeY, 11 * s, 13 * s * eyeOpen, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#1a1a1a';
    ctx.beginPath();
    ctx.arc(side * eyeDX + 2 * s, eyeY, 5.5 * s * Math.min(1, eyeOpen + 0.3), 0, Math.PI * 2);
    ctx.fill();
  }
  // Eyebrows (raise on react)
  const browLift = pose.phase === 'react' ? -8 * s : -2 * s;
  ctx.strokeStyle = HAIR;
  ctx.lineWidth = 4 * s;
  ctx.lineCap = 'round';
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * eyeDX - 10 * s, eyeY - 20 * s + browLift);
    ctx.lineTo(side * eyeDX + 10 * s, eyeY - 22 * s + browLift);
    ctx.stroke();
  }
  // Mouth: talking opens/closes, react = O, else a smile
  ctx.fillStyle = '#7c2d12';
  if (pose.phase === 'react') {
    ctx.beginPath();
    ctx.ellipse(0, 26 * s, 10 * s, 13 * s * pose.mouthOpen, 0, 0, Math.PI * 2);
    ctx.fill();
  } else if (pose.mouthOpen > 0.45) {
    ctx.beginPath();
    ctx.ellipse(0, 26 * s, 14 * s, 9 * s * pose.mouthOpen, 0, 0, Math.PI * 2);
    ctx.fill();
  } else {
    ctx.strokeStyle = '#7c2d12';
    ctx.lineWidth = 3.5 * s;
    ctx.beginPath();
    ctx.arc(0, 18 * s, 16 * s, Math.PI * 0.15, Math.PI * 0.85);
    ctx.stroke();
  }
  ctx.restore();

  // --- Arms (screen space, from shoulder to hand) ---
  const drawArm = (shoulderX, shoulderY, arm, sleeveColor) => {
    const upper = 68 * s;
    const fore = 62 * s;
    const elbowX = shoulderX + Math.cos(arm.upperAngle) * upper;
    const elbowY = shoulderY + Math.sin(arm.upperAngle) * upper;
    const foreAngle = arm.upperAngle + arm.elbowBend * (arm.upperAngle < 0 ? 1 : -1) * 0.6;
    // For a pointing arm keep the forearm almost straight.
    const fa = Math.abs(arm.elbowBend) < 0.2 ? arm.upperAngle : foreAngle;
    const handX = elbowX + Math.cos(fa) * fore;
    const handY = elbowY + Math.sin(fa) * fore;
    ctx.strokeStyle = sleeveColor;
    ctx.lineWidth = 24 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(shoulderX, shoulderY);
    ctx.lineTo(elbowX, elbowY);
    ctx.lineTo(handX, handY);
    ctx.stroke();
    // Hand
    ctx.fillStyle = SKIN;
    ctx.beginPath();
    ctx.arc(handX, handY, 13 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = SKIN_DARK;
    ctx.lineWidth = 2 * s;
    ctx.stroke();
    return { handX, handY };
  };
  const shoulderY = feetY - 320 * s;
  drawArm(cx - 52 * s, shoulderY, pose.armL, SHIRT_DARK);
  const rightHand = drawArm(cx + 52 * s, shoulderY, pose.armR, SHIRT);
  // Pointer stick in the pointing hand, so the point reads at a glance.
  if (pose.phase === 'point' && pose.action === 'walk-point') {
    ctx.strokeStyle = '#ffd166';
    ctx.lineWidth = 5 * s;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(rightHand.handX, rightHand.handY);
    ctx.lineTo(
      rightHand.handX + Math.cos(pose.armR.upperAngle) * 46 * s,
      rightHand.handY + Math.sin(pose.armR.upperAngle) * 46 * s
    );
    ctx.stroke();
  }

  ctx.restore();
  return pose;
}

/**
 * Animate a user-supplied transparent-PNG character cutout as its own
 * layer: it walks in from the side, bobs and leans while talking, and
 * hops on the payoff — independent of the background camera.
 * A flat cutout cannot articulate limbs; the movement here is
 * position / squash-and-stretch / tilt, which is the honest limit of
 * a single PNG. For articulated limbs, use the procedural presenter.
 */
export function renderCharacterCutout(ctx, { img, t = 0, duration = 4, width = 1080, height = 1920, action = 'walk-point', seed = 1, focusX = 0.5, focusY = 0.42 } = {}) {
  if (!img) return null;
  const pose = getCharacterPose(t, { duration, width, height, action, seed, focusX, focusY });
  const targetH = height * 0.42;
  const imgW = Number(img.naturalWidth || img.width || 1);
  const imgH = Number(img.naturalHeight || img.height || 1);
  const targetW = targetH * (imgW / imgH);
  const squash = pose.phase === 'react'
    ? 1 + 0.06 * Math.sin((pose.progress - 0.74) / 0.26 * Math.PI)
    : 1 + 0.02 * Math.sin(t * Math.PI * 2 * 0.45);
  const stretch = 1 / Math.sqrt(squash);

  ctx.save();
  // Ground shadow
  ctx.fillStyle = 'rgba(0, 0, 0, 0.30)';
  ctx.beginPath();
  ctx.ellipse(pose.anchorX, pose.feetY + 8, targetW * 0.42, 14, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.translate(pose.anchorX, pose.feetY - pose.bobY);
  ctx.rotate(pose.torsoLean * 0.7);
  ctx.scale(squash, stretch);
  ctx.drawImage(img, -targetW / 2, -targetH, targetW, targetH);
  ctx.restore();
  return pose;
}
