/* Bloom — hand-tracked hero
   Video 1: frame sequence scrubbed by hand openness (fist = closed, open hand = full bloom)
   Snap   : bloom → Video 2 (burn). Snap again → Video 3 (reverse back to bloom).
   Keys   : Space = snap · M = mouse control · C = camera ghost · D = debug values
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
  // snap: thumb+middle pinched, then within ~0.4 s the middle finger flicks down into the palm
  snapPinch: 0.42,       // thumb-tip ↔ middle-tip, palm units
  snapRelease: 0.75,
  snapDrop: 0.22,        // middle tip must drop this much toward the wrist
  snapWindow: 420,       // ms
  snapCooldown: 1300,    // ms
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
  hand: null, handAt: 0, ratio: null,
  hist: [], lastSnap: -1e9, snapQueued: false,
  showCam: false, debug: false,
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
  S.hist.length = 0;
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
  const hasHand = S.hand && performance.now() - S.handAt < 400;
  media.classList.toggle('has-hand', !!hasHand || S.input === 'mouse');

  switch (S.phase) {
    case 'loading': label = `Loading ${Math.round(S.loadP * 100)}%`; m = S.loadP; break;
    case 'bloom':
      m = S.t;
      if (S.input === 'mouse') label = S.camStatus === 'denied' || S.camStatus === 'error'
        ? 'No camera · move mouse · space = snap' : 'Mouse mode · space = snap';
      else if (S.camStatus !== 'live') label = S.camStatus === 'starting' ? 'Starting camera' : 'Loading hand model';
      else if (!hasHand) label = 'Show your hand';
      else label = S.t > 0.9 ? 'Snap your fingers' : 'Open your hand';
      break;
    case 'toBurn': label = 'Snap'; m = 1; break;
    case 'burn':
      m = v2.duration ? v2.currentTime / v2.duration : 0;
      label = v2.ended ? 'Snap to bring them back' : (S.snapQueued ? 'Queued' : 'Burning');
      break;
    case 'restore': m = v3.duration ? 1 - v3.currentTime / v3.duration : 0; label = 'Blooming'; break;
  }
  if (label !== lastLabel) { labelEl.textContent = label; lastLabel = label; }
  meterEl.style.transform = `scaleX(${clamp01(m || 0).toFixed(4)})`;

  drawSkeleton();
  if (S.debug) {
    const h = S._dbg || {};
    debugEl.textContent =
      `phase ${S.phase}\ninput ${S.input}\nratio ${(S.ratio ?? 0).toFixed(2)}  [${CFG.openLo.toFixed(2)}–${CFG.openHi.toFixed(2)}]\n` +
      `open  ${S.targetT.toFixed(2)}\npinch ${(h.d ?? 0).toFixed(2)}\nmid   ${(h.m ?? 0).toFixed(2)}`;
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
      runningMode: 'VIDEO', numHands: 1,
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
    onHand(res.landmarks?.[0] || null, now);
  }
  requestAnimationFrame(detectLoop);
}

function onHand(lm, now) {
  if (!lm) { S.hand = null; return; }
  const aw = cam.videoWidth || 640, ah = cam.videoHeight || 480;
  const P = lm.map(p => ({ x: p.x * aw, y: p.y * ah, z: p.z * aw }));
  S.hand = P; S.handAt = now;
  const d3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  const palm = Math.max(1, d3(P[0], P[9]));
  const ratio = ([8, 12, 16, 20].reduce((s, i) => s + d3(P[i], P[0]), 0) / 4) / palm;
  S.ratio = S.ratio == null ? ratio : S.ratio * 0.55 + ratio * 0.45;

  // gentle self-calibration: widen the range if your fist / open hand goes beyond it
  if (S.ratio < CFG.openLo) CFG.openLo = Math.max(0.75, CFG.openLo + (S.ratio - CFG.openLo) * 0.05);
  if (S.ratio > CFG.openHi) CFG.openHi = Math.min(2.3, CFG.openHi + (S.ratio - CFG.openHi) * 0.05);

  if (S.input === 'camera') S.targetT = clamp01((S.ratio - CFG.openLo) / (CFG.openHi - CFG.openLo));

  detectSnap(P, palm, now, d3);
}

function detectSnap(P, palm, now, d3) {
  const d = d3(P[4], P[12]) / palm;   // thumb tip ↔ middle tip
  const m = d3(P[12], P[0]) / palm;   // middle tip ↔ wrist
  S._dbg = { d, m };
  S.hist.push({ t: now, d, m });
  while (S.hist.length && now - S.hist[0].t > CFG.snapWindow) S.hist.shift();

  if (d < CFG.snapRelease) return;
  for (const h of S.hist) {
    if (h.d < CFG.snapPinch && m < h.m - CFG.snapDrop && now - h.t > 15) { snap('gesture'); return; }
  }
}

// skeleton — auto-framed so the hand always sits nicely in the box (like the Figma placeholder)
const BONES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],
               [9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
function drawSkeleton() {
  const W = skel.width, H = skel.height;
  sctx.clearRect(0, 0, W, H);
  const P = S.hand && performance.now() - S.handAt < 400 ? S.hand : null;
  const dpr = W / (media.clientWidth || 1);

  if (!P) { if (S.showCam && cam.readyState >= 2) ghost(null, W, H); return; }

  // target framing: centre of the hand → box centre, palm length → 21% of box height
  let cx = 0, cy = 0; for (const p of P) { cx += p.x; cy += p.y; } cx /= 21; cy /= 21;
  const palm = Math.hypot(P[0].x - P[9].x, P[0].y - P[9].y) || 1;
  const s = (H * 0.21) / palm;
  if (!S.view) S.view = { cx, cy, s };
  S.view.cx += (cx - S.view.cx) * 0.25;
  S.view.cy += (cy - S.view.cy) * 0.25;
  S.view.s += (s - S.view.s) * 0.12;
  const V = S.view;
  const map = p => ({ x: W / 2 - (p.x - V.cx) * V.s, y: H * 0.5 + (p.y - V.cy) * V.s }); // mirrored

  if (S.showCam && cam.readyState >= 2) ghost(V, W, H);

  const Q = P.map(map);
  sctx.strokeStyle = '#fff'; sctx.lineWidth = 1 * dpr; sctx.lineJoin = 'round';
  sctx.beginPath();
  for (const [a, b] of BONES) { sctx.moveTo(Q[a].x, Q[a].y); sctx.lineTo(Q[b].x, Q[b].y); }
  sctx.stroke();
  sctx.fillStyle = '#fff';
  const r = 2.64 * dpr;
  for (const q of Q) { sctx.beginPath(); sctx.arc(q.x, q.y, r, 0, Math.PI * 2); sctx.fill(); }
}
function ghost(V, W, H) {
  const aw = cam.videoWidth, ah = cam.videoHeight;
  sctx.save();
  sctx.globalAlpha = 0.28;
  sctx.filter = 'grayscale(1) contrast(1.2)';
  if (V) {
    sctx.translate(W / 2 + V.cx * V.s, H / 2 - V.cy * V.s);
    sctx.scale(-V.s, V.s);
    sctx.drawImage(cam, 0, 0, aw, ah);
  } else {
    const s = Math.max(W / aw, H / ah);
    sctx.translate(W, 0); sctx.scale(-1, 1);
    sctx.drawImage(cam, (W - aw * s) / 2, (H - ah * s) / 2, aw * s, ah * s);
  }
  sctx.restore();
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
window.__bloom = { S, CFG, snap, onHand };

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
