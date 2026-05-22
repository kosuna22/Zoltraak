const canvas = document.getElementById("draw-canvas");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const flash = document.getElementById("flash");
const spellVideo = document.getElementById("spell-video");
const spellAudio = document.getElementById("spell-audio");
const hint = document.getElementById("hint");
const guide = document.getElementById("guide");

const AUDIO_START_SEC = 20;
const VIDEO_ZOLTRAAK = "졸트라크.mp4";
const VIDEO_FERN = "페른.mp4";
const FLASH_DURATION_MS = 1100;

const CIRCLE_GEO_THRESHOLD = 0.42;
const CIRCLE_UNI_THRESHOLD = 0.52;
const STAR_UNI_THRESHOLD = 0.52;
const MIN_STROKE_POINTS = 10;

const CIRCLE_TEMPLATE = buildCircleTemplate(125, 125, 100);
const STAR_TEMPLATES = [
  buildStarTemplate(125, 125, 70, [0, 2, 4, 1, 3, 0]),
  buildStarTemplate(125, 125, 70, [0, 1, 2, 3, 4, 0]),
  buildStarTemplate(125, 125, 70, [0, 3, 1, 4, 2, 0]),
];

let isPlaying = false;
let isCasting = false;
let playbackPhase = null;
let strokePoints = [];
let savedStrokes = [];
let isDrawing = false;
let pattern = { circle: false, star: false };

function buildCircleTemplate(cx, cy, r) {
  const pts = [];
  for (let i = 0; i < 64; i++) {
    const a = (i / 64) * Math.PI * 2;
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return pts;
}

function buildStarTemplate(cx, cy, r, order) {
  const verts = [];
  for (let i = 0; i < 5; i++) {
    const a = -Math.PI / 2 + i * ((2 * Math.PI) / 5);
    verts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  }
  return order.map((i) => verts[i]);
}

// --- $1 Unistroke Recognizer ---

const NumPoints = 64;
const SquareSize = 250;
const Origin = { x: 125, y: 125 };
const Diagonal = Math.hypot(SquareSize, SquareSize);
const AngleRange = Math.PI / 2;
const AnglePrecision = (2 * Math.PI) / 180;

function resample(points, n) {
  if (points.length < 2) return points;
  const interval = pathLength(points) / (n - 1);
  let D = 0;
  const resampled = [points[0]];
  const src = points.map((p) => ({ ...p }));

  for (let i = 1; i < src.length; i++) {
    const d = dist(src[i - 1], src[i]);
    if (d < 1e-6) continue;
    if (D + d >= interval) {
      const qx =
        src[i - 1].x + ((interval - D) / d) * (src[i].x - src[i - 1].x);
      const qy =
        src[i - 1].y + ((interval - D) / d) * (src[i].y - src[i - 1].y);
      const q = { x: qx, y: qy };
      resampled.push(q);
      src.splice(i, 0, q);
      D = 0;
    } else {
      D += d;
    }
  }
  if (resampled.length < n) resampled.push(src[src.length - 1]);
  return resampled.slice(0, n);
}

function pathLength(points) {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1], points[i]);
  return len;
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centroid(points) {
  let x = 0;
  let y = 0;
  for (const p of points) {
    x += p.x;
    y += p.y;
  }
  const n = points.length;
  return { x: x / n, y: y / n };
}

function rotateBy(points, radians, c) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return points.map((p) => ({
    x: (p.x - c.x) * cos - (p.y - c.y) * sin + c.x,
    y: (p.x - c.x) * sin + (p.y - c.y) * cos + c.y,
  }));
}

function scaleTo(points, size) {
  const minX = Math.min(...points.map((p) => p.x));
  const minY = Math.min(...points.map((p) => p.y));
  const maxX = Math.max(...points.map((p) => p.x));
  const maxY = Math.max(...points.map((p) => p.y));
  const w = maxX - minX || 1;
  const h = maxY - minY || 1;
  const scale = size / Math.max(w, h);
  return points.map((p) => ({
    x: (p.x - minX) * scale,
    y: (p.y - minY) * scale,
  }));
}

function translateTo(points, target) {
  const c = centroid(points);
  return points.map((p) => ({
    x: p.x + target.x - c.x,
    y: p.y + target.y - c.y,
  }));
}

function normalize(points) {
  let pts = resample(points, NumPoints);
  pts = scaleTo(pts, SquareSize);
  pts = translateTo(pts, Origin);
  const c = centroid(pts);
  const theta = Math.atan2(c.y - Origin.y, c.x - Origin.x);
  pts = rotateBy(pts, -theta, Origin);
  return pts;
}

function pathDistance(a, b) {
  const len = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < len; i++) d += dist(a[i], b[i]);
  return d / len;
}

function recognize(candidate, template) {
  if (candidate.length < MIN_STROKE_POINTS) return 0;
  const normalized = normalize(candidate);
  const target = normalize(template);
  let best = Infinity;

  for (
    let angle = -AngleRange;
    angle <= AngleRange;
    angle += AnglePrecision
  ) {
    const rotated = rotateBy(normalized, angle, Origin);
    const d = pathDistance(rotated, target);
    if (d < best) best = d;
  }

  return 1 - best / (0.5 * Diagonal);
}

function circleGeometryScore(points) {
  if (points.length < MIN_STROKE_POINTS) return 0;

  const c = centroid(points);
  const radii = points.map((p) => dist(p, c));
  const avg = radii.reduce((a, b) => a + b, 0) / radii.length;
  if (avg < 22) return 0;

  const variance =
    radii.reduce((s, r) => s + (r - avg) ** 2, 0) / radii.length;
  const cv = Math.sqrt(variance) / avg;

  const len = pathLength(points);
  const expected = 2 * Math.PI * avg;
  const lenScore = Math.min(len, expected) / Math.max(len, expected);

  const gap = dist(points[0], points[points.length - 1]);
  const closedScore = Math.max(0, 1 - gap / (avg * 0.75));

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const w = Math.max(...xs) - Math.min(...xs);
  const h = Math.max(...ys) - Math.min(...ys);
  const aspect = Math.min(w, h) / Math.max(w, h || 1);

  const roundScore = Math.max(0, 1 - cv / 0.38);
  const aspectScore = aspect > 0.5 ? (aspect - 0.5) / 0.5 : 0;

  return (
    roundScore * 0.4 +
    lenScore * 0.3 +
    closedScore * 0.2 +
    aspectScore * 0.1
  );
}

function isCircleStroke(points) {
  const geo = circleGeometryScore(points);
  const uni = recognize(points, CIRCLE_TEMPLATE);
  return geo >= CIRCLE_GEO_THRESHOLD || uni >= CIRCLE_UNI_THRESHOLD;
}

function isStarStroke(points) {
  return STAR_TEMPLATES.some(
    (t) => recognize(points, t) >= STAR_UNI_THRESHOLD
  );
}

function classifyStroke(points) {
  const circle = isCircleStroke(points);
  const star = isStarStroke(points);
  if (circle && !star) return "circle";
  if (star && !circle) return "star";
  if (circle && star) {
    const geo = circleGeometryScore(points);
    const starScore = Math.max(
      ...STAR_TEMPLATES.map((t) => recognize(points, t))
    );
    return geo >= starScore ? "circle" : "star";
  }
  return null;
}

function resetPattern() {
  pattern = { circle: false, star: false };
  savedStrokes = [];
}

function updateHintText() {
  if (pattern.circle && !pattern.star) {
    hint.textContent = "원 안에 별을 그려주세요";
  } else if (!pattern.circle && pattern.star) {
    hint.textContent = "마법진의 원을 그려주세요";
  } else if (!pattern.circle) {
    hint.textContent = "마법진의 원을 먼저 그려주세요";
  }
}

function showFailHint() {
  hint.classList.add("fail");
  if (pattern.circle && !pattern.star) {
    hint.textContent = "별 모양으로 다시 그려보세요";
  } else if (!pattern.circle && pattern.star) {
    hint.textContent = "원 모양으로 다시 그려보세요";
  } else {
    hint.textContent = "가이드처럼 원 → 별 순서로 그려보세요";
  }
  setTimeout(() => {
    hint.classList.remove("fail");
    updateHintText();
  }, 800);
}

// --- 그리기 ---

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = window.innerWidth;
  const h = window.innerHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  redrawCanvas();
}

function clearCanvas() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
}

function drawPoints(points) {
  if (points.length < 2) return;
  ctx.strokeStyle = "#7ef9ff";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = "#7ef9ff";
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.moveTo(points[0].x, points[0].y);
  for (let i = 1; i < points.length; i++) {
    ctx.lineTo(points[i].x, points[i].y);
  }
  ctx.stroke();
  ctx.shadowBlur = 0;
}

function redrawCanvas() {
  clearCanvas();
  for (const stroke of savedStrokes) drawPoints(stroke);
  drawPoints(strokePoints);
}

function getPoint(e) {
  const rect = canvas.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function onPointerDown(e) {
  if (isPlaying || isCasting) return;
  isDrawing = true;
  canvas.setPointerCapture(e.pointerId);
  strokePoints = [getPoint(e)];
  redrawCanvas();
}

function onPointerMove(e) {
  if (!isDrawing || isPlaying || isCasting) return;
  strokePoints.push(getPoint(e));
  redrawCanvas();
}

function onPointerUp(e) {
  if (!isDrawing) return;
  isDrawing = false;
  canvas.releasePointerCapture(e.pointerId);

  if (strokePoints.length < MIN_STROKE_POINTS) {
    strokePoints = [];
    redrawCanvas();
    return;
  }

  const type = classifyStroke(strokePoints);
  let recognized = false;

  if (type === "circle" && !pattern.circle) {
    pattern.circle = true;
    recognized = true;
  } else if (type === "star" && !pattern.star) {
    pattern.star = true;
    recognized = true;
  }

  if (recognized) {
    savedStrokes.push([...strokePoints]);
    strokePoints = [];
    redrawCanvas();
    updateHintText();

    if (pattern.circle && pattern.star) {
      triggerMagicCast();
    }
  } else if (!pattern.circle || !pattern.star) {
    showFailHint();
    strokePoints = [];
    redrawCanvas();
  } else {
    strokePoints = [];
    redrawCanvas();
  }
}

// --- 빛 효과 → 재생 ---

function playFlashEffect() {
  return new Promise((resolve) => {
    flash.classList.remove("hidden");
    flash.classList.add("active");
    flash.setAttribute("aria-hidden", "false");

    window.setTimeout(() => {
      flash.classList.remove("active");
      flash.classList.add("hidden");
      flash.setAttribute("aria-hidden", "true");
      resolve();
    }, FLASH_DURATION_MS);
  });
}

async function triggerMagicCast() {
  isCasting = true;
  canvas.classList.add("disabled");
  guide.classList.add("success");
  hint.classList.add("hidden");
  resetPattern();
  clearCanvas();

  await playFlashEffect();

  isCasting = false;
  await startPlayback();
}

async function startPlayback() {
  if (isPlaying) return;
  isPlaying = true;
  guide.classList.add("hidden");
  overlay.classList.remove("hidden");
  overlay.setAttribute("aria-hidden", "false");

  playbackPhase = "zoltraak";
  spellVideo.src = VIDEO_ZOLTRAAK;
  spellVideo.currentTime = 0;
  spellAudio.currentTime = AUDIO_START_SEC;

  try {
    await Promise.all([spellVideo.play(), spellAudio.play()]);
  } catch (err) {
    console.error("재생 실패:", err);
    stopPlayback();
  }
}

function stopPlayback() {
  if (!isPlaying) return;
  isPlaying = false;
  isCasting = false;
  playbackPhase = null;
  spellVideo.pause();
  spellAudio.pause();
  spellVideo.src = VIDEO_ZOLTRAAK;
  spellVideo.currentTime = 0;
  spellAudio.currentTime = AUDIO_START_SEC;
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  hint.classList.remove("hidden");
  hint.textContent = "마법진의 원을 먼저 그려주세요";
  guide.classList.remove("hidden", "success");
  canvas.classList.remove("disabled");
  resetPattern();
}

async function playNextVideo() {
  if (!isPlaying) return;

  if (playbackPhase === "zoltraak") {
    playbackPhase = "fern";
    spellVideo.src = VIDEO_FERN;
    spellVideo.currentTime = 0;
    try {
      await spellVideo.play();
    } catch (err) {
      console.error("페른.mp4 재생 실패:", err);
      stopPlayback();
    }
    return;
  }

  stopPlayback();
}

canvas.addEventListener("pointerdown", onPointerDown);
canvas.addEventListener("pointermove", onPointerMove);
canvas.addEventListener("pointerup", onPointerUp);
canvas.addEventListener("pointercancel", onPointerUp);
spellVideo.addEventListener("ended", playNextVideo);
window.addEventListener("resize", resizeCanvas);

resizeCanvas();
