// recognizer.js — pure $1-style single-stroke gesture recognizer.
//
// DOM-free so the SAME recognizer runs on the client and (Phase 2) the
// authoritative server. Pipeline (MASTERPLAN §5): resample -> translate ->
// uniform scale (aspect + direction preserved, rotation NOT normalized) ->
// compare against the caller-selected template pool -> accept only when the best
// score clears the spell threshold AND beats the runner-up by a margin. Duels use
// the full roster; tutorials/laboratory may intentionally scope the pool.

const DEFAULT_N = 24;

export function pathLength(pts) {
  let d = 0;
  for (let i = 1; i < pts.length; i++) {
    d += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  }
  return d;
}

// Remove near-duplicate points and light jitter before resampling.
export function dedupe(pts, minDist = 0.5) {
  if (pts.length === 0) return [];
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i];
    const q = out[out.length - 1];
    if (Math.hypot(p.x - q.x, p.y - q.y) >= minDist) out.push(p);
  }
  return out;
}

export function resample(pts, n = DEFAULT_N) {
  const clean = dedupe(pts.map((p) => ({ x: p.x, y: p.y })));
  if (clean.length < 2) return clean.length ? new Array(n).fill(0).map(() => ({ ...clean[0] })) : [];
  const I = pathLength(clean) / (n - 1);
  const out = [{ ...clean[0] }];
  let D = 0;
  const src = clean.slice();
  for (let i = 1; i < src.length; i++) {
    let d = Math.hypot(src[i].x - src[i - 1].x, src[i].y - src[i - 1].y);
    if (D + d >= I) {
      const t = I === 0 ? 0 : (I - D) / d;
      const q = {
        x: src[i - 1].x + t * (src[i].x - src[i - 1].x),
        y: src[i - 1].y + t * (src[i].y - src[i - 1].y),
      };
      out.push(q);
      src.splice(i, 0, q);
      D = 0;
    } else {
      D += d;
    }
  }
  while (out.length < n) out.push({ ...clean[clean.length - 1] });
  return out.slice(0, n);
}

export function centroid(pts) {
  let x = 0, y = 0;
  for (const p of pts) { x += p.x; y += p.y; }
  return { x: x / pts.length, y: y / pts.length };
}

// Translate to centroid, then uniform-scale by the largest extent so the
// aspect ratio and direction survive (a horizontal line stays horizontal).
export function normalize(pts) {
  if (pts.length === 0) return [];
  const c = centroid(pts);
  let maxExt = 1e-6;
  for (const p of pts) {
    maxExt = Math.max(maxExt, Math.abs(p.x - c.x), Math.abs(p.y - c.y));
  }
  return pts.map((p) => ({ x: (p.x - c.x) / (2 * maxExt), y: (p.y - c.y) / (2 * maxExt) }));
}

export function preprocess(pts, n = DEFAULT_N) {
  return normalize(resample(pts, n));
}

export function meanDistance(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return Infinity;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.hypot(a[i].x - b[i].x, a[i].y - b[i].y);
  return sum / n;
}

// Map a mean normalized distance (0 = identical) into a 0..1 score.
export function distanceToScore(d) {
  return Math.max(0, 1 - d * 2.2);
}

function startAxisFit(points, axis) {
  if (!axis || points.length < 2) return 1;
  const end = points[Math.max(1, Math.floor((points.length - 1) * 0.25))];
  const dx = Math.abs(end.x - points[0].x);
  const dy = Math.abs(end.y - points[0].y);
  const total = dx + dy;
  if (total < 1e-6) return 0.5;
  return axis === 'horizontal' ? dx / total : dy / total;
}

function segmentDistance(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const denom = dx * dx + dy * dy;
  if (denom < 1e-12) return Math.hypot(point.x - start.x, point.y - start.y);
  const t = Math.max(0, Math.min(1,
    ((point.x - start.x) * dx + (point.y - start.y) * dy) / denom));
  return Math.hypot(point.x - (start.x + t * dx), point.y - (start.y + t * dy));
}

function simplifyOpen(points, tolerance) {
  if (points.length <= 2) return points;
  let maxDistance = 0, split = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = segmentDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) { maxDistance = distance; split = i; }
  }
  if (maxDistance <= tolerance) return [points[0], points[points.length - 1]];
  return [
    ...simplifyOpen(points.slice(0, split + 1), tolerance).slice(0, -1),
    ...simplifyOpen(points.slice(split), tolerance),
  ];
}

function simplifyClosed(points, tolerance = 0.08) {
  if (points.length < 4) return points;
  const closed = Math.hypot(
    points[0].x - points[points.length - 1].x,
    points[0].y - points[points.length - 1].y,
  ) < 0.16;
  if (!closed) return simplifyOpen(points, tolerance);
  let farthest = 1, farthestDistance = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const distance = Math.hypot(points[i].x - points[0].x, points[i].y - points[0].y);
    if (distance > farthestDistance) { farthestDistance = distance; farthest = i; }
  }
  return [
    ...simplifyOpen(points.slice(0, farthest + 1), tolerance).slice(0, -1),
    ...simplifyOpen(points.slice(farthest), tolerance),
  ];
}

function turnConcentration(points) {
  const turns = [];
  for (let i = 1; i < points.length - 1; i++) {
    const a = Math.atan2(points[i].y - points[i - 1].y, points[i].x - points[i - 1].x);
    const b = Math.atan2(points[i + 1].y - points[i].y, points[i + 1].x - points[i].x);
    let turn = Math.abs(b - a);
    if (turn > Math.PI) turn = Math.PI * 2 - turn;
    turns.push(turn);
  }
  const total = turns.reduce((sum, turn) => sum + turn, 0);
  return total > 1e-6 ? Math.max(...turns) / total : 0;
}

function closedShapeClass(points) {
  if (points.length < 7) return null;
  const closed = Math.hypot(
    points[0].x - points[points.length - 1].x,
    points[0].y - points[points.length - 1].y,
  ) < 0.16;
  if (!closed) return null;
  const simplified = simplifyClosed(points);
  const concentration = turnConcentration(simplified);
  if (simplified.length <= 4 && concentration >= 0.27) return 'triangle';
  if (simplified.length <= 7 && concentration >= 0.27) return 'diamond';
  if (simplified.length >= 7 && concentration <= 0.24) return 'round';
  return null;
}

export class Recognizer {
  constructor(templates = [], opts = {}) {
    this.n = opts.n || DEFAULT_N;
    this.acceptThreshold = opts.acceptThreshold ?? 0.62;
    this.marginThreshold = opts.marginThreshold ?? 0.06;
    this.minPoints = opts.minPoints ?? 3;
    this.templates = templates.map((t) => ({
      name: t.name, spellId: t.spellId, gestureKey: t.gestureKey,
      startAxis: t.startAxis || null,
      pts: preprocess(t.points, this.n),
    }));
  }

  // Restrict classification to a selected template subset (tutorial/lab use).
  forLoadout(loadout) {
    const keys = new Set(loadout.map((s) => s.gestureKey || s.id));
    const ids = new Set(loadout.map((s) => s.id));
    const subset = this.templates.filter((t) => ids.has(t.spellId) || keys.has(t.gestureKey));
    const r = Object.create(Recognizer.prototype);
    r.n = this.n; r.acceptThreshold = this.acceptThreshold;
    r.marginThreshold = this.marginThreshold; r.minPoints = this.minPoints;
    r.templates = subset;
    return r;
  }

  recognize(points) {
    const diag = { accepted: false, reason: null, scores: [], best: null, second: null, margin: 0, requiredMargin: this.marginThreshold };
    const raw = (points || []).filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y));
    if (raw.length < this.minPoints) { diag.reason = 'too-few-points'; return diag; }
    if (this.templates.length === 0) { diag.reason = 'no-templates'; return diag; }

    const q = preprocess(raw, this.n);
    const shapePoints = normalize(dedupe(raw));
    const shapeClass = closedShapeClass(shapePoints);
    diag.shapeClass = shapeClass;
    const scores = this.templates.map((t) => {
      let score = Math.max(0, distanceToScore(meanDistance(q, t.pts))
        - (1 - startAxisFit(q, t.startAxis)) * 0.22);
      if (shapeClass === 'round') {
        if (t.spellId === 11 || t.spellId === 13) score += 0.12;
        else if (t.spellId === 20) score -= 0.16;
      } else if (shapeClass === 'diamond') {
        if (t.spellId === 20) score += 0.16;
        else if (t.spellId === 11 || t.spellId === 13) score -= 0.12;
        else if (t.spellId === 8) score -= 0.08;
      } else if (shapeClass === 'triangle') {
        if (t.spellId === 8) score += 0.16;
        else if (t.spellId === 20) score -= 0.14;
        else if (t.spellId === 11 || t.spellId === 13) score -= 0.10;
      }
      return {
      spellId: t.spellId, name: t.name, gestureKey: t.gestureKey,
        score: Math.max(0, Math.min(1, score)),
      };
    }).sort((a, b) => b.score - a.score);

    diag.scores = scores;
    diag.best = scores[0];
    // The runner-up for ambiguity must be a DIFFERENT spell, not another
    // template of the same spell.
    const rival = scores.find((s) => s.spellId !== scores[0].spellId) || null;
    diag.second = rival;
    diag.margin = scores[0].score - (rival ? rival.score : 0);
    if (shapeClass === 'round' && (scores[0].spellId === 11 || scores[0].spellId === 13)
        && scores[0].score >= 0.78) {
      diag.requiredMargin = 0.005;
    }
    if (scores[0].spellId === 15 && scores[0].score >= 0.78) {
      diag.requiredMargin = Math.min(diag.requiredMargin, 0.015);
    }
    if (scores[0].spellId === 5 && scores[0].score >= 0.80 && rival?.spellId !== 39) {
      diag.requiredMargin = Math.min(diag.requiredMargin, 0.01);
    }
    if (scores[0].spellId === 7 && scores[0].score >= 0.80) {
      diag.requiredMargin = Math.min(diag.requiredMargin, 0.02);
    }
    if (scores[0].spellId === 30 && scores[0].score >= 0.78) {
      diag.requiredMargin = Math.min(diag.requiredMargin, 0.015);
    }

    const closed = Math.hypot(q[0].x - q[q.length - 1].x, q[0].y - q[q.length - 1].y) < 0.16;
    if (raw.length < 6 && closed && (scores[0].spellId === 11 || scores[0].spellId === 13 || scores[0].spellId === 20)) {
      diag.reason = 'ambiguous';
      return diag;
    }
    if (scores[0].score < this.acceptThreshold) { diag.reason = 'below-threshold'; return diag; }
    if (rival && diag.margin < diag.requiredMargin) { diag.reason = 'ambiguous'; return diag; }

    diag.accepted = true;
    diag.spellId = scores[0].spellId;
    diag.name = scores[0].name;
    diag.reason = 'accepted';
    return diag;
  }
}
