/* Bloom — hand-tracked hero
   Video 1: frame sequence scrubbed by hand openness (fist = closed, open hand = full bloom)
   Clap / palms together (or snap): bloom → Video 2 (burn). Again → Video 3 (back to bloom).
   Keys   : Space = trigger · M = mouse control · C = camera feed on/off · D = debug values
*/
import { FilesetResolver, HandLandmarker } from './vendor/mediapipe/vision_bundle.mjs';

// ─────────────────────────────── config
const CFG = {
  frames: 121,
  frameSrc: i => `frames1/f${String(i + 1).padStart(3, '0')}.jpg`,
  srcW: 1788, srcH: 1156,
  // openness = avg fingertip→wrist distance / palm length
  openLo: 1.05,          // ≈ fist
  openHi: 1.80,          // ≈ open hand
  follow: 4.5,           // how fast the video follows your hand (higher = snappier)
  // clap / palms together (two hands): main trigger
  clapHit: 1.3,          // palm centres closer than this (palm lengths) = clap
  clapArm: 2.0,          // hands must be at least this far apart first
  // snap (one hand): thumb+middle pinched, then within ~0.4 s the middle finger flicks into the palm
  snapPinch: 0.42,       // thumb-tip ↔ middle-tip, palm units
  snapIndex: 1.35,       // index finger still extended = "about to snap", not a fist
  snapHold: 450,         // ms the flowers stay frozen after the snap pose is seen
  snapRelease: 0.75,
  snapDrop: 0.22,        // middle tip must drop this much toward the wrist
  snapWindow: 420,       // ms
  snapCooldown: 1300,    // ms (shared by clap and snap)
  // text cues inside videos 2 / 3 (seconds)
  burnTextIn: 2.5,
  restoreTextOut: 1.3,
  restoreTextIn: 2.6,
};

// ─────────────────────────────── dom
const $ = s => document.querySelector(s);
const bg = $('#bg'), ctx = bg.getContext('2d', { alpha: false });
const v2 = $('#v2'), v3 = $('#v3'), cam = $('#cam');
const media = $('#media'), skel = $('#skel'), sctx = skel.getContext('2d');
const labelEl = $('#label'), meterEl = $('#meter'), debugEl = $('#debug'), ringEl = $('#ring');
const textA = $('#textA'), textB = $('#textB');

const clamp01 = v => Math.max(0, Math.min(1, v));
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));

// ─────────────────────────────── state
const S = {
  phase: 'loading',     // loading | bloom | toBurn | burn | restore
  t: 0, targetT: 0,     // openness 0..1 (displayed / target)
  lastIdx: -1, dirty: true,
  input: 'camera',      // camera | mouse
  hands: [], handAt: 0, ratio: null,
  hist: {}, lastSnap: -1e9, snapQueued: false,
  frozen: false, frozenUntil: 0, clapArmed: false, clapDist: null, lastTwo: null,
  showCam: true, debug: false,
  cue: {},              // one-shot text cues per video run
  loadP: 0, camStatus: 'starting',
  view: null,           // skeleton auto-framing
};

// ─────────────────────────────── text
const LINES_A = [
  [['A'], ['big,'], ['happy', 1], ['flower', 1]],
  [['that'], ['follows'], ['the'], ['sun'], ['it']],
  [['grows', 1], ['strong', 1], ['and'], ['tall,']],
  [['with'], ['a'], ['face'], ['full'], ['of'], ['seeds.']],
];
const wordEls = [];
function wordSpan(txt, i, italic) {
  const w = document.createElement('span'); w.className = 'w';
  const wi = document.createElement('span'); wi.className = 'wi'; wi.style.setProperty('--i', i);
  const wp = document.createElement(italic ? 'em' : 'span'); wp.className = 'wp'; wp.textContent = txt;
  wi.appendChild(wp); w.appendChild(wi);
  return { w, wp };
}
(function buildText() {
  let i = 0;
  for (const line of LINES_A) {
    const l = document.createElement('span'); l.className = 'line'; l.setAttribute('aria-hidden', 'true');
    line.forEach(([txt, it], k) => {
      const { w, wp } = wordSpan(txt, i++, it);
      l.appendChild(w); wordEls.push({ el: wp, p: -1 });
      if (k < line.length - 1) l.appendChild(document.createTextNode(' '));
    });
    textA.appendChild(l);
  }
  // "n v m ;)" — v in italic, per Figma
  const l = document.createElement('span'); l.className = 'line'; l.setAttribute('aria-hidden', 'true');
  [['n'], ['v', 1], ['m'], [' '], [';'], [')']].forEach(([c, it], k) => {
    if (c === ' ') { l.appendChild(document.createTextNode(' ')); return; }
    l.appendChild(wordSpan(c, k, it).w);
  });
  textB.appendChild(l);
})();

function showText(el) {
  el.classList.add('no-tr'); el.classList.remove('in', 'out');
  void el.offsetWidth;
  el.classList.remove('no-tr'); el.classList.add('in');
}
function hideText(el) { el.classList.remove('in'); el.classList.add('out'); }

function applyWordOpenness(t) {
  const n = wordEls.length;
  for (let i = 0; i < n; i++) {
    // words bloom left → right as the hand opens
    const start = (i / n) * 0.55;
    const p = clamp01((t - start) / 0.45);
    const o = wordEls[i];
    if (Math.abs(o.p - p) > 0.004) { o.p = p; o.el.style.setProperty('--p', p.toFixed(3)); }
  }
}

// fonts: tighter tracking only for PP Editorial Old (Figma: -2.8px @ 56px)
document.fonts.load('400 56px Editorial').then(() => {
  for (const f of document.fonts) if (f.family.replace(/"/g, '') === 'Editorial' && f.status === 'loaded') {
    document.documentElement.classList.add('has-editorial'); break;
  }
}).catch(() => {});

// ─────────────────────────────── frames (video 1)
const frames = new Array(CFG.frames);
function loadFrames() {
  let done = 0;
  const one = i => new Promise(res => {
    const img = new Image();
    img.decoding = 'async';
    img.src = CFG.frameSrc(i);
    const fin = () => { done++; S.loadP = done / CFG.frames; res(); };
    img.onload = () => (img.decode ? img.decode().catch(() => {}) : Promise.resolve()).then(() => { frames[i] = img; if (i === 0) S.dirty = true; fin(); });
    img.onerror = fin;
  });
  // first frame first, then the rest
  return one(0).then(() => Promise.all(Array.from({ length: CFG.frames - 1 }, (_, k) => one(k + 1))));
}
function frameNear(idx) {
  for (let d = 0; d < CFG.frames; d++) {
    if (frames[idx - d]) return frames[idx - d];
    if (frames[idx + d]) return frames[idx + d];
  }
  return null;
}

// ─────────────────────────────── canvas
function resize() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  bg.width = Math.round(innerWidth * dpr);
  bg.height = Math.round(innerHeight * dpr);
  const r = media.getBoundingClientRect();
  skel.width = Math.round(r.width * dpr);
  skel.height = Math.round(r.height * dpr);
  S.dirty = true;
}
addEventListener('resize', resize);

function drawCover(src, sw, sh) {
  const cw = bg.width, ch = bg.height;
  const s = Math.max(cw / sw, ch / sh);
  const dw = sw * s, dh = sh * s;
  ctx.drawImage(src, (cw - dw) / 2, (ch - dh) / 2, dw, dh);
}

function render() {
  const p = S.phase;
  if (p === 'loading' || p === 'bloom' || p === 'toBurn') {
    const idx = Math.round(S.t * (CFG.frames - 1));
    if (idx !== S.lastIdx || S.dirty) {
      const img = frameNear(idx);
      if (img) { drawCover(img, CFG.srcW, CFG.srcH); S.lastIdx = idx; S.dirty = false; }
    }
  } else {
    const v = p === 'burn' ? v2 : v3;
    // keep the previous picture until the next video has a real frame → no black flash
    if (v.readyState >= 2 && v.currentTime > 0 && (!v.paused || S.dirty)) {
      drawCover(v, v.videoWidth, v.videoHeight); S.dirty = false;
    }
  }
}

// ─────────────────────────────── phases
function snap(source = 'gesture') {
  const now = performance.now();
  if (now - S.lastSnap < CFG.snapCooldown) return;
  if (S.phase === 'loading' || S.phase === 'toBurn' || S.phase === 'restore') return;
  S.lastSnap = now;
  S.hist = {};
  S.frozenUntil = 0;
  pulse();

  if (S.phase === 'bloom') {
    S.phase = 'toBurn';               // finish opening the flowers, then hand over to video 2
    hideText(textA);
  } else if (S.phase === 'burn') {
    if (v2.ended) startRestore(); else S.snapQueued = true;
  }
  if (S.debug) console.log('[snap]', source);
}

function startBurn() {
  S.phase = 'burn'; S.cue = {}; S.snapQueued = false;
  v2.currentTime = 0;
  v2.play().catch(() => {});
}
function startRestore() {
  S.phase = 'restore'; S.cue = {};
  v3.currentTime = 0;
  v3.play().catch(() => {});
}
v2.addEventListener('ended', () => { if (S.snapQueued) { S.snapQueued = false; startRestore(); } });
v3.addEventListener('ended', () => {
  S.phase = 'bloom';
  S.t = 1; S.targetT = 1;             // land on full bloom, then your hand takes over again
  S.lastIdx = -1; S.dirty = true;
  if (!S.cue.aIn) { S.cue.aIn = true; showText(textA); }
});

function pulse() {
  media.classList.add('snapped');
  setTimeout(() => media.classList.remove('snapped'), 160);
  const r = media.getBoundingClientRect(), h = $('#hero').getBoundingClientRect();
  ringEl.style.left = (r.left + r.width / 2 - h.left) + 'px';
  ringEl.style.top = (r.top + r.height / 2 - h.top) + 'px';
  const reach = Math.hypot(innerWidth, innerHeight) * 2.1 / 60;
  ringEl.animate(
    [{ transform: 'scale(.4)', opacity: .9 }, { transform: `scale(${reach})`, opacity: 0 }],
    { duration: 1400, easing: 'cubic-bezier(.16,1,.3,1)' }
  );
}

// ─────────────────────────────── main loop
let last = performance.now();
function tick(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;

  if (S.phase === 'bloom') {
    S.t = damp(S.t, S.targetT, CFG.follow, dt);
    applyWordOpenness(S.t);
  } else if (S.phase === 'toBurn') {
    S.t = damp(S.t, 1, 7, dt);
    if (S.t > 0.995) { S.t = 1; render(); startBurn(); }
  } else if (S.phase === 'burn') {
    if (!S.cue.bIn && v2.currentTime >= CFG.burnTextIn) { S.cue.bIn = true; showText(textB); }
  } else if (S.phase === 'restore') {
    if (!S.cue.bOut && v3.currentTime >= CFG.restoreTextOut) { S.cue.bOut = true; hideText(textB); }
    if (!S.cue.aIn && v3.currentTime >= CFG.restoreTextIn) { S.cue.aIn = true; applyWordOpenness(1); showText(textA); }
  }

  render();
  updateUI();
  requestAnimationFrame(tick);
}

// ─────────────────────────────── UI in the media box
let lastLabel = '';
function updateUI() {
  let label, m;
  const hasHand = S.hands.length > 0 && performance.now() - S.handAt < 400;
  media.classList.toggle('has-hand', hasHand || S.input === 'mouse' || (S.showCam && S.camStatus === 'live'));

  switch (S.phase) {
    case 'loading': label = `Loading ${Math.round(S.loadP * 100)}%`; m = S.loadP; break;
    case 'bloom':
      m = S.t;
      if (S.input === 'mouse') label = S.camStatus === 'denied' || S.camStatus === 'error'
        ? 'No camera · move mouse · space = clap' : 'Mouse mode · space = clap';
      else if (S.camStatus !== 'live') label = S.camStatus === 'starting' ? 'Starting camera' : 'Loading hand model';
      else if (!hasHand) label = 'Show your hand';
      else if (S.frozen) label = 'Hold…';
      else label = S.t > 0.9 ? 'Clap or snap' : 'Open your hand';
      break;
    case 'toBurn': label = '✦'; m = 1; break;
    case 'burn':
      m = v2.duration ? v2.currentTime / v2.duration : 0;
      label = v2.ended ? 'Clap to bring them back' : (S.snapQueued ? 'Queued' : 'Burning');
      break;
    case 'restore': m = v3.duration ? 1 - v3.currentTime / v3.duration : 0; label = 'Blooming'; break;
  }
  if (label !== lastLabel) { labelEl.textContent = label; lastLabel = label; }
  meterEl.style.transform = `scaleX(${clamp01(m || 0).toFixed(4)})`;

  drawBox();
  if (S.debug) {
    const h = S._dbg || {};
    debugEl.textContent =
      `phase ${S.phase}  hands ${S.hands.length}\nratio ${(S.ratio ?? 0).toFixed(2)}  [${CFG.openLo.toFixed(2)}–${CFG.openHi.toFixed(2)}]\n` +
      `open  ${S.targetT.toFixed(2)}${S.frozen ? '  (frozen)' : ''}\npinch ${(h.d ?? 0).toFixed(2)}  mid ${(h.m ?? 0).toFixed(2)}\n` +
      `clap  ${S.clapDist == null ? '–' : S.clapDist.toFixed(2)}${S.clapArmed ? '  armed' : ''}`;
  }
}

// ─────────────────────────────── hand tracking
let landmarker = null;

async function initCamera() {
  if (!navigator.mediaDevices?.getUserMedia) { S.camStatus = 'error'; S.input = 'mouse'; return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user', frameRate: { ideal: 60 } },
      audio: false,
    });
    cam.srcObject = stream;
    await cam.play();
    S.camStatus = 'model';
  } catch (e) {
    console.warn('Camera unavailable:', e);
    S.camStatus = 'denied'; S.input = 'mouse'; return;
  }
  try {
    const fileset = await FilesetResolver.forVisionTasks(new URL('vendor/mediapipe/wasm', location.href).href);
    const opts = delegate => ({
      baseOptions: { modelAssetPath: new URL('vendor/mediapipe/hand_landmarker.task', location.href).href, delegate },
      runningMode: 'VIDEO', numHands: 2,
      minHandDetectionConfidence: 0.6, minHandPresenceConfidence: 0.5, minTrackingConfidence: 0.5,
    });
    try { landmarker = await HandLandmarker.createFromOptions(fileset, opts('GPU')); }
    catch { landmarker = await HandLandmarker.createFromOptions(fileset, opts('CPU')); }
    S.camStatus = 'live';
    detectLoop();
  } catch (e) {
    console.error('Hand model failed:', e);
    S.camStatus = 'error'; S.input = 'mouse';
  }
}

let lastCamTime = -1;
function detectLoop() {
  if (S.detect !== false && cam.readyState >= 2 && cam.currentTime !== lastCamTime) {
    lastCamTime = cam.currentTime;
    const now = performance.now();
    const res = landmarker.detectForVideo(cam, now);
    const lms = res.landmarks || [];
    const sides = (res.handedness || res.handednesses || []).map(h => h?.[0]?.categoryName || '');
    onHands(lms, sides, now);
  }
  requestAnimationFrame(detectLoop);
}

const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const palmCenter = P => {
  let x = 0, y = 0, z = 0;
  for (const i of [0, 5, 9, 13, 17]) { x += P[i].x; y += P[i].y; z += P[i].z; }
  return { x: x / 5, y: y / 5, z: z / 5 };
};

function onHands(lms, sides, now) {
  const aw = cam.videoWidth || 640, ah = cam.videoHeight || 480;
  const hands = lms.map((lm, i) => {
    const P = lm.map(p => ({ x: p.x * aw, y: p.y * ah, z: p.z * aw }));
    const palm = Math.max(1, d3(P[0], P[9]));
    const ratio = ([8, 12, 16, 20].reduce((s, k) => s + d3(P[k], P[0]), 0) / 4) / palm;
    return { P, palm, ratio, side: sides[i] || String(i), c: palmCenter(P) };
  });
  S.hands = hands;
  if (!hands.length) { detectClap(hands, now); return; }
  S.handAt = now;

  // openness = average of visible hands
  const ratio = hands.reduce((s, h) => s + h.ratio, 0) / hands.length;
  S.ratio = S.ratio == null ? ratio : S.ratio * 0.55 + ratio * 0.45;
  if (S.ratio < CFG.openLo) CFG.openLo = Math.max(0.75, CFG.openLo + (S.ratio - CFG.openLo) * 0.05);
  if (S.ratio > CFG.openHi) CFG.openHi = Math.min(2.3, CFG.openHi + (S.ratio - CFG.openHi) * 0.05);

  // snap prep (thumb on middle finger, index still extended) → hold the flowers where they are
  let prep = false;
  for (const h of hands) if (detectSnap(h, now)) prep = true;
  if (prep) S.frozenUntil = now + CFG.snapHold;
  S.frozen = now < S.frozenUntil;

  if (S.input === 'camera' && !S.frozen) S.targetT = clamp01((S.ratio - CFG.openLo) / (CFG.openHi - CFG.openLo));

  detectClap(hands, now);
}

// Clap / palms together: two hands, palm centres come within ~1.3 palm lengths.
// Also counts it when two close hands suddenly merge into one detection (they often do on contact).
function detectClap(hands, now) {
  if (hands.length >= 2) {
    const [a, b] = hands;
    const dist = d3(a.c, b.c) / ((a.palm + b.palm) / 2);
    S.clapDist = dist;
    S.lastTwo = { t: now, dist };
    if (dist > CFG.clapArm) S.clapArmed = true;
    if (S.clapArmed && dist < CFG.clapHit) { S.clapArmed = false; snap('clap'); }
  } else {
    S.clapDist = null;
    const lt = S.lastTwo;
    if (S.clapArmed && lt && now - lt.t < 260 && lt.dist < CFG.clapHit * 1.5) { S.clapArmed = false; snap('clap'); }
  }
}

// returns true while the hand is in the "about to snap" pose
function detectSnap(h, now) {
  const { P, palm, side } = h;
  const d = d3(P[4], P[12]) / palm;     // thumb tip ↔ middle tip
  const m = d3(P[12], P[0]) / palm;     // middle tip ↔ wrist
  const idx = d3(P[8], P[0]) / palm;    // index extension
  S._dbg = { d, m };
  const hist = S.hist[side] || (S.hist[side] = []);
  hist.push({ t: now, d, m });
  while (hist.length && now - hist[0].t > CFG.snapWindow) hist.shift();

  const prep = d < CFG.snapPinch && idx > CFG.snapIndex;
  if (d >= CFG.snapRelease) {
    for (const e of hist) {
      if (e.d < CFG.snapPinch && m < e.m - CFG.snapDrop && now - e.t > 15) { snap('snap'); hist.length = 0; break; }
    }
  }
  return prep;
}

// ─────────────────────────────── media box: live camera + skeleton
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
               [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawBox() {
  const W = skel.width, H = skel.height;
  sctx.clearRect(0, 0, W, H);
  const dpr = W / (media.clientWidth || 1);
  const aw = cam.videoWidth || 640, ah = cam.videoHeight || 480;
  // cover-fit the camera into the portrait box, mirrored like a selfie
  const s = Math.max(W / aw, H / ah);
  const ox = (W - aw * s) / 2, oy = (H - ah * s) / 2;

  if (S.showCam && cam.readyState >= 2) {
    sctx.save();
    sctx.translate(W, 0); sctx.scale(-1, 1);
    sctx.drawImage(cam, ox, oy, aw * s, ah * s);
    sctx.restore();
    sctx.fillStyle = 'rgba(0,0,0,.28)';           // keeps the white skeleton readable
    sctx.fillRect(0, 0, W, H);
  }

  if (!S.hands.length || performance.now() - S.handAt > 400) return;
  const map = p => ({ x: W - (ox + p.x * s), y: oy + p.y * s });
  sctx.strokeStyle = '#fff'; sctx.fillStyle = '#fff';
  sctx.lineWidth = 1 * dpr; sctx.lineJoin = 'round';
  const r = 2.64 * dpr;
  for (const h of S.hands) {
    const Q = h.P.map(map);
    sctx.beginPath();
    for (const [a, b] of BONES) { sctx.moveTo(Q[a].x, Q[a].y); sctx.lineTo(Q[b].x, Q[b].y); }
    sctx.stroke();
    for (const q of Q) { sctx.beginPath(); sctx.arc(q.x, q.y, r, 0, Math.PI * 2); sctx.fill(); }
  }
}

// ─────────────────────────────── fallbacks & keys
addEventListener('pointermove', e => { if (S.input === 'mouse') S.targetT = clamp01(e.clientX / innerWidth); });
$('#hero').addEventListener('click', () => snap('click'));
addEventListener('keydown', e => {
  if (e.code === 'Space') { e.preventDefault(); snap('key'); }
  else if (e.key === 'm' || e.key === 'M') S.input = S.input === 'mouse' && S.camStatus === 'live' ? 'camera' : 'mouse';
  else if (e.key === 'c' || e.key === 'C') S.showCam = !S.showCam;
  else if (e.key === 'd' || e.key === 'D') { S.debug = !S.debug; debugEl.hidden = !S.debug; }
});

// test hook (used for automated checks; harmless in production)
window.__bloom = { S, CFG, snap, onHands };

// ─────────────────────────────── boot
resize();
requestAnimationFrame(tick);
v2.load(); v3.load();
initCamera();
loadFrames().then(() => {
  S.phase = 'bloom';
  applyWordOpenness(S.t);
  showText(textA);
});
