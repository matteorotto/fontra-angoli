// Angoli — plugin per Fontra
// Arrotonda o smussa gli angoli dei contorni, con anteprima live sul canvas.
// Si installa da Impostazioni → Plugin Manager indicando il repository GitHub.

const PANEL_ID = "corners";
const PANEL_TAG = "angoli-corner-panel";
const LAYER_ID = "plugin.angoli.preview";
const STORAGE_KEY = "fontra-plugin-angoli-settings";

const DEFAULTS = {
  mode: "round", // "round" | "chamfer"
  radius: 30,
  tension: 1,
  scope: "selection", // "selection" | "glyph"
  filter: "both", // "convex" | "concave" | "both"
  allMasters: true,
  roundCoords: true,
  preview: true,
  keepTension: true, // cambiando il raggio di un angolo già arrotondato ne mantiene la tensione
};

const MIN_ANGLE = (1 * Math.PI) / 180;
const MIN_ANGLE_SMOOTH = (10 * Math.PI) / 180;
const MAX_ANGLE = (178 * Math.PI) / 180;
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Geometria
// ---------------------------------------------------------------------------

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a, s) => ({ x: a.x * s, y: a.y * s });
const vlen = (a) => Math.hypot(a.x, a.y);
const dot = (a, b) => a.x * b.x + a.y * b.y;
const cross = (a, b) => a.x * b.y - a.y * b.x;
const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const xy = (p) => ({ x: p.x, y: p.y });

function norm(a) {
  const l = vlen(a);
  return l > EPS ? { x: a.x / l, y: a.y / l } : null;
}

function isOffCurve(p) {
  return p.type === "cubic" || p.type === "quad";
}

function signedArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

export function analyzeContour(contour) {
  const pts = contour.points;
  const n = pts.length;
  const closed = !!contour.isClosed;
  const on = [];
  for (let i = 0; i < n; i++) {
    if (!isOffCurve(pts[i])) {
      on.push(i);
    }
  }
  if (on.length < 2) {
    return null;
  }
  if (!closed && (isOffCurve(pts[0]) || isOffCurve(pts[n - 1]))) {
    return null;
  }
  const m = on.length;
  const segCount = closed ? m : m - 1;
  const segments = [];
  for (let k = 0; k < segCount; k++) {
    const a = on[k];
    const b = on[(k + 1) % m];
    const offs = [];
    for (let i = (a + 1) % n; i !== b; i = (i + 1) % n) {
      offs.push(i);
    }
    let kind = "other";
    if (offs.length === 0) {
      kind = "line";
    } else if (
      offs.length === 2 &&
      pts[offs[0]].type === "cubic" &&
      pts[offs[1]].type === "cubic"
    ) {
      kind = "cubic";
    }
    segments.push({ startOn: k, endOn: (k + 1) % m, a, b, offs, kind });
  }
  return { pts, closed, on, segments };
}

function segmentPoints(info, seg) {
  const pts = info.pts;
  return [xy(pts[seg.a]), ...seg.offs.map((i) => xy(pts[i])), xy(pts[seg.b])];
}

function endTangent(P) {
  const e = P[P.length - 1];
  for (let i = P.length - 2; i >= 0; i--) {
    const d = norm(sub(e, P[i]));
    if (d) return d;
  }
  return null;
}

function startTangent(P) {
  const s = P[0];
  for (let i = 1; i < P.length; i++) {
    const d = norm(sub(P[i], s));
    if (d) return d;
  }
  return null;
}

function cornerAt(info, j) {
  const m = info.on.length;
  let kin, kout;
  if (info.closed) {
    kin = (j - 1 + m) % m;
    kout = j;
  } else {
    if (j === 0 || j === m - 1) return null;
    kin = j - 1;
    kout = j;
  }
  const sin = info.segments[kin];
  const sout = info.segments[kout];
  if (sin.kind === "other" || sout.kind === "other") return null;
  const tin = endTangent(segmentPoints(info, sin));
  const tout = startTangent(segmentPoints(info, sout));
  if (!tin || !tout) return null;
  const phi = Math.acos(clamp(dot(tin, tout), -1, 1));
  return { kin, kout, tin, tout, phi, cross: cross(tin, tout) };
}

function readContours(path) {
  const contours = [];
  for (let ci = 0; ci < path.numContours; ci++) {
    contours.push(path.getUnpackedContour(ci));
  }
  return contours;
}

// Trova gli angoli "veri" di un tracciato. Un angolo è convesso se sporge
// verso l'esterno della forma piena (indipendentemente dal verso del contorno).
// Verso dei contorni esterni del glifo: serve a capire da che parte sta il nero
function inkSignOf(contours) {
  let biggest = 0;
  let inkSign = 1;
  for (const c of contours) {
    const a = signedArea(c.points);
    if (Math.abs(a) > biggest) {
      biggest = Math.abs(a);
      inkSign = a >= 0 ? 1 : -1;
    }
  }
  return inkSign;
}

export function findCorners(path) {
  const contours = readContours(path);
  const inkSign = inkSignOf(contours);
  const result = [];
  let base = 0;
  contours.forEach((contour, ci) => {
    const info = analyzeContour(contour);
    if (info) {
      for (let j = 0; j < info.on.length; j++) {
        const c = cornerAt(info, j);
        const li = info.on[j];
        // un nodo "smooth" con un piccolo scarto (es. dopo l'arrotondamento a
        // coordinate intere) non è un angolo vero
        const minAngle = info.pts[li].smooth ? MIN_ANGLE_SMOOTH : MIN_ANGLE;
        if (!c || c.phi < minAngle || c.phi > MAX_ANGLE) continue;
        result.push({
          ci, li, abs: base + li, convex: c.cross * inkSign > 0,
          V: xy(info.pts[li]), dirIn: c.tin, dirOut: c.tout, phi: c.phi,
        });
      }
    }
    base += contour.points.length;
  });
  return result;
}

function cubicPoint(P, t) {
  const u = 1 - t;
  return {
    x: u * u * u * P[0].x + 3 * u * u * t * P[1].x + 3 * u * t * t * P[2].x + t * t * t * P[3].x,
    y: u * u * u * P[0].y + 3 * u * u * t * P[1].y + 3 * u * t * t * P[2].y + t * t * t * P[3].y,
  };
}

function cubicLengthTable(P, steps = 100) {
  const table = [0];
  let prev = P[0];
  let total = 0;
  for (let i = 1; i <= steps; i++) {
    const p = cubicPoint(P, i / steps);
    total += vlen(sub(p, prev));
    table.push(total);
    prev = p;
  }
  return table;
}

function segmentLength(P) {
  if (P.length === 2) return vlen(sub(P[1], P[0]));
  const table = cubicLengthTable(P);
  return table[table.length - 1];
}

function tAtLength(table, s) {
  const steps = table.length - 1;
  const total = table[steps];
  if (s <= 0) return 0;
  if (s >= total) return 1;
  let lo = 0;
  let hi = steps;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (table[mid] < s) lo = mid;
    else hi = mid;
  }
  const span = table[hi] - table[lo];
  const f = span > EPS ? (s - table[lo]) / span : 0;
  return (lo + f) / steps;
}

function splitCubic(P, t) {
  const p01 = lerp(P[0], P[1], t);
  const p12 = lerp(P[1], P[2], t);
  const p23 = lerp(P[2], P[3], t);
  const p012 = lerp(p01, p12, t);
  const p123 = lerp(p12, p23, t);
  const p0123 = lerp(p012, p123, t);
  return [
    [P[0], p01, p012, p0123],
    [p0123, p123, p23, P[3]],
  ];
}

function trimSegment(P, d0, d1) {
  if (d0 <= EPS && d1 <= EPS) return P.map(xy);
  if (P.length === 2) {
    const v = sub(P[1], P[0]);
    const L = vlen(v);
    if (L < EPS) return P.map(xy);
    return [add(P[0], mul(v, d0 / L)), sub(P[1], mul(v, d1 / L))];
  }
  const table = cubicLengthTable(P);
  const L = table[table.length - 1];
  const t0 = tAtLength(table, d0);
  const t1 = Math.max(t0, tAtLength(table, L - d1));
  if (t1 < EPS) return [P[0], P[0], P[0], P[0]].map(xy);
  const [left] = splitCubic(P, t1);
  if (t0 <= EPS) return left;
  const [, right] = splitCubic(left, t0 / t1);
  return right;
}

function handleFactor(phi) {
  if (phi < 1e-6) return 2 / 3;
  return ((4 / 3) * Math.tan(phi / 4)) / Math.tan(phi / 2);
}

function roundValue(v, doRound) {
  return doRound ? Math.round(v) : Math.round(v * 1000) / 1000;
}

function makePoint(p, type, smooth, attrs, isNew, roundCoords) {
  const pt = {
    x: isNew ? roundValue(p.x, roundCoords) : p.x,
    y: isNew ? roundValue(p.y, roundCoords) : p.y,
  };
  if (type) pt.type = type;
  if (!type && smooth) pt.smooth = true;
  if (attrs) pt.attrs = attrs;
  return pt;
}

// Restituisce un nuovo contorno (formato "unpacked" di Fontra) con gli angoli
// indicati (indici locali dei punti on-curve) arrotondati o smussati.
export function roundContour(contour, cornerIndices, opts) {
  const info = analyzeContour(contour);
  if (!info) return null;
  const { on, segments, pts, closed } = info;
  const m = on.length;
  const isRound = opts.mode !== "chamfer";
  const rc = !!opts.roundCoords;

  const corners = new Map();
  for (let j = 0; j < m; j++) {
    if (!cornerIndices.has(on[j])) continue;
    const c = cornerAt(info, j);
    if (!c) continue;
    const phi = Math.min(c.phi, MAX_ANGLE);
    corners.set(j, { ...c, phi, d: Math.max(0, opts.radius) * Math.tan(phi / 2) });
  }
  if (!corners.size) return null;

  // 1) quanto spazio c'è su ogni segmento: se i due angoli alle estremità
  //    chiedono più della sua lunghezza, il raggio viene ridotto in proporzione
  const segInfo = segments.map((seg) => {
    const P = segmentPoints(info, seg);
    const L = segmentLength(P);
    const want0 = corners.has(seg.startOn) ? corners.get(seg.startOn).d : 0;
    const want1 = corners.has(seg.endOn) ? corners.get(seg.endOn).d : 0;
    const scale = want0 + want1 > L ? L / (want0 + want1) : 1;
    return { P, scale };
  });
  // 2) ogni angolo usa la riduzione più forte dei suoi due lati, così il
  //    raccordo resta un arco regolare invece di diventare asimmetrico
  for (const c of corners.values()) {
    c.d *= Math.min(segInfo[c.kin].scale, segInfo[c.kout].scale);
  }
  const segData = segments.map((seg, k) => {
    const { P } = segInfo[k];
    let d0 = corners.has(seg.startOn) ? corners.get(seg.startOn).d : 0;
    let d1 = corners.has(seg.endOn) ? corners.get(seg.endOn).d : 0;
    if (!closed && seg.startOn === 0) d0 = 0;
    if (!closed && seg.endOn === m - 1) d1 = 0;
    return { P, d0, d1, T: trimSegment(P, d0, d1) };
  });

  const out = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    const { T } = segData[k];
    const startCorner = corners.has(seg.startOn) && !(!closed && seg.startOn === 0);

    if (startCorner) {
      // con raggio 0 (raccordo "chiuso" nei master non attivi) il nodo resta un angolo
      out.push(makePoint(T[0], undefined, isRound && corners.get(seg.startOn).d > EPS, null, true, rc));
    } else {
      const orig = pts[seg.a];
      out.push(makePoint(orig, undefined, orig.smooth, orig.attrs, false, rc));
    }

    if (seg.kind === "cubic") {
      const changed = segData[k].d0 > EPS || segData[k].d1 > EPS;
      out.push(makePoint(T[1], "cubic", false, pts[seg.offs[0]].attrs, changed, rc));
      out.push(makePoint(T[2], "cubic", false, pts[seg.offs[1]].attrs, changed, rc));
    } else {
      for (const i of seg.offs) {
        out.push({ ...pts[i] });
      }
    }

    const endCorner = corners.has(seg.endOn) && (closed || seg.endOn !== m - 1);
    if (endCorner) {
      const c = corners.get(seg.endOn);
      const next = segData[c.kout];
      const S1 = T[T.length - 1];
      const S2 = next.T[0];
      out.push(makePoint(S1, undefined, isRound && c.d > EPS, null, true, rc));
      if (isRound) {
        const dirIn = endTangent(T) || c.tin;
        const dirOut = startTangent(next.T) || c.tout;
        const f = handleFactor(c.phi) * (opts.tension ?? 1);
        const h1 = add(S1, mul(dirIn, segData[k].d1 * f));
        const h2 = sub(S2, mul(dirOut, next.d0 * f));
        out.push(makePoint(h1, "cubic", false, null, true, rc));
        out.push(makePoint(h2, "cubic", false, null, true, rc));
      }
    }
  }
  if (!closed) {
    const last = pts[on[m - 1]];
    out.push(makePoint(last, undefined, last.smooth, last.attrs, false, rc));
  }
  return { points: out, isClosed: closed };
}

export function packContour(contour) {
  const coordinates = [];
  const pointTypes = [];
  const pointAttributes = [];
  let hasAttrs = false;
  for (const p of contour.points) {
    coordinates.push(p.x, p.y);
    let t = p.type === "cubic" ? 2 : p.type === "quad" ? 1 : 0;
    if (t === 0 && p.smooth) t |= 8;
    pointTypes.push(t);
    if (p.attrs && Object.keys(p.attrs).length) {
      hasAttrs = true;
      pointAttributes.push({ ...p.attrs });
    } else {
      pointAttributes.push(null);
    }
  }
  return {
    coordinates,
    pointTypes,
    pointAttributes: hasAttrs ? pointAttributes : null,
    isClosed: contour.isClosed,
  };
}

function structureSignature(path) {
  const parts = [];
  for (let ci = 0; ci < path.numContours; ci++) {
    const c = path.getUnpackedContour(ci);
    parts.push((c.isClosed ? "C" : "O") + c.points.map((p) => (p.type ? p.type[0] : "o")).join(""));
  }
  return parts.join("|");
}

function selectedPointIndices(selection) {
  const result = new Set();
  for (const item of selection || []) {
    const [tp, index] = String(item).split("/");
    if (tp === "point") result.add(parseInt(index, 10));
  }
  return result;
}

export function targetCorners(path, selection, settings) {
  let corners = findCorners(path);
  if (settings.scope === "selection") {
    const sel = selectedPointIndices(selection);
    corners = corners.filter((c) => sel.has(c.abs));
  }
  if (settings.filter === "convex") corners = corners.filter((c) => c.convex);
  if (settings.filter === "concave") corners = corners.filter((c) => !c.convex);
  return corners;
}

function groupByContour(corners) {
  const byContour = new Map();
  for (const c of corners) {
    if (!byContour.has(c.ci)) byContour.set(c.ci, new Set());
    byContour.get(c.ci).add(c.li);
  }
  return byContour;
}

// Calcola i nuovi contorni per un tracciato: Map(indice contorno → contorno)
export function computeRoundedContours(path, byContour, opts) {
  const result = new Map();
  for (const [ci, indices] of byContour) {
    const newContour = roundContour(path.getUnpackedContour(ci), indices, opts);
    if (newContour) result.set(ci, newContour);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Angoli arrotondati modificabili ("live corners", come in Illustrator)
//
// Un raccordo è: nodo A → maniglia → maniglia → nodo B, tangente in A al
// segmento che arriva e in B a quello che riparte. Le due tangenti si
// incontrano nello spigolo "virtuale" V: da lì si ricavano raggio e tensione.
// Cambiare il raggio sposta solo quei quattro punti (e, se il lato vicino è
// una curva, le sue maniglie): il numero di punti non cambia mai, quindi i
// master restano compatibili e l'interpolazione funziona.
// Un raccordo con raggio 0 ha i quattro punti sovrapposti nello spigolo: è
// un angolo vivo "pronto" per essere arrotondato in quel master.
// ---------------------------------------------------------------------------

const FILLET_TANGENT_TOL = (3 * Math.PI) / 180;
const FILLET_MIN_ANGLE = (5 * Math.PI) / 180;
const FILLET_MAX_ANGLE = (175 * Math.PI) / 180;
const COLLAPSED_TOL = 0.5;

function angleBetween(a, b) {
  return Math.acos(clamp(dot(a, b), -1, 1));
}

// Intersezione tra la retta per p con direzione d e la retta per q con direzione e
function intersectLines(p, d, q, e) {
  const den = cross(d, e);
  if (Math.abs(den) < 1e-9) return null;
  const t = cross(sub(q, p), e) / den;
  return add(p, mul(d, t));
}

function isCollapsedFillet(F) {
  return (
    vlen(sub(F[3], F[0])) < COLLAPSED_TOL &&
    vlen(sub(F[1], F[0])) < COLLAPSED_TOL &&
    vlen(sub(F[2], F[3])) < COLLAPSED_TOL
  );
}

// Geometria del raccordo sul segmento k (curva da A a B). Con strict=true
// applica anche i controlli di riconoscimento; con strict=false calcola solo
// la geometria (serve negli altri master, che possono essere diversi).
function filletGeometry(info, k, strict) {
  const m = info.on.length;
  const segs = info.segments;
  const seg = segs[k];
  if (!seg || seg.kind !== "cubic") return null;
  let kin, kout;
  if (info.closed) {
    if (m < 3) return null;
    kin = (k - 1 + m) % m;
    kout = (k + 1) % m;
  } else {
    if (k === 0 || k >= segs.length - 1) return null;
    kin = k - 1;
    kout = k + 1;
  }
  const sIn = segs[kin];
  const sOut = segs[kout];
  if (sIn.kind === "other" || sOut.kind === "other") return null;
  const Pin = segmentPoints(info, sIn);
  const F = segmentPoints(info, seg);
  const Pout = segmentPoints(info, sOut);
  const [A, h1, h2, B] = F;
  // Se il lato vicino è un tratto dritto lungo zero (due raccordi che si
  // toccano, es. una testa semicircolare) usiamo la tangente del raccordo stesso.
  const degenerateIn = sIn.kind === "line" && vlen(sub(Pin[1], Pin[0])) < COLLAPSED_TOL;
  const degenerateOut = sOut.kind === "line" && vlen(sub(Pout[1], Pout[0])) < COLLAPSED_TOL;
  const dirIn = (!degenerateIn && endTangent(Pin)) || norm(sub(h1, A)) || norm(sub(h2, A));
  const dirOut = (!degenerateOut && startTangent(Pout)) || norm(sub(B, h2)) || norm(sub(B, h1));
  if (!dirIn || !dirOut) return null;
  const collapsed = isCollapsedFillet(F);

  // Spigolo virtuale V e direzioni dei due lati nello spigolo. Se un lato è
  // una curva, lo spigolo vero sta sul prolungamento della curva (dove
  // incontra la retta dell'altro lato), non sulla sua tangente.
  let V;
  let cornerIn = dirIn;
  let cornerOut = dirOut;
  let dA, dB;
  if (collapsed) {
    V = lerp(A, B, 0.5);
    dA = 0;
    dB = 0;
  } else {
    V = intersectLines(A, dirIn, B, dirOut);
    if (!V) return null;
    dA = dot(sub(V, A), dirIn);
    dB = dot(sub(B, V), dirOut);
    if (sIn.kind === "cubic" && sOut.kind === "line") {
      const t = curveLineCrossing(Pin, B, dirOut, 1, 7);
      if (t !== null) {
        V = cubicPoint(Pin, t);
        cornerIn = cubicTangent(Pin, t) || dirIn;
        dA = arcTable(Pin, 1, t).total;
        dB = dot(sub(B, V), dirOut);
      }
    } else if (sOut.kind === "cubic" && sIn.kind === "line") {
      const t = curveLineCrossing(Pout, A, dirIn, 0, -6);
      if (t !== null) {
        V = cubicPoint(Pout, t);
        cornerOut = cubicTangent(Pout, t) || dirOut;
        dB = arcTable(Pout, t, 0).total;
        dA = dot(sub(V, A), dirIn);
      }
    }
  }
  const phi = angleBetween(cornerIn, cornerOut);

  if (strict) {
    if (phi < FILLET_MIN_ANGLE || phi > FILLET_MAX_ANGLE) return null;
    if (!collapsed) {
      const t1 = norm(sub(h1, A)) || norm(sub(h2, A));
      const t2 = norm(sub(B, h2)) || norm(sub(B, h1));
      if (!t1 || !t2) return null;
      if (angleBetween(dirIn, t1) > FILLET_TANGENT_TOL) return null;
      if (angleBetween(t2, dirOut) > FILLET_TANGENT_TOL) return null;
      if (dA < -0.5 || dB < -0.5) return null;
      if (vlen(sub(h1, A)) > dA + 1 || vlen(sub(h2, B)) > dB + 1) return null;
      const lo = Math.max(Math.min(dA, dB), 0.5);
      if (Math.max(dA, dB) / lo > 3) return null; // troppo asimmetrico per essere un raccordo
      // almeno un lato dritto: evita di scambiare per angoli le normali curve
      if (sIn.kind !== "line" && sOut.kind !== "line") return null;
    }
  }

  const d = Math.max(0, (dA + dB) / 2);
  const halfTan = Math.tan(Math.min(phi, MAX_ANGLE) / 2);
  const radius = halfTan > EPS ? d / halfTan : 0;
  let tension = null;
  if (!collapsed && dA > EPS && dB > EPS) {
    const ratio = (vlen(sub(h1, A)) / dA + vlen(sub(h2, B)) / dB) / 2;
    tension = ratio / handleFactor(phi);
  }
  return {
    k, kin, kout, V, dirIn, dirOut, cornerIn, cornerOut, phi, dA, dB, radius, tension, collapsed,
    iA: seg.a, ih1: seg.offs[0], ih2: seg.offs[1], iB: seg.b,
    cross: cross(cornerIn, cornerOut),
  };
}

function cubicTangent(P, t) {
  const h = 1e-4;
  return norm(sub(cubicPoint(P, t + h), cubicPoint(P, t - h)));
}

// Parametro (il più vicino a tFrom, cercando verso tTo) in cui il polinomio
// della curva attraversa la retta per lineP con direzione lineDir
function curveLineCrossing(P, lineP, lineDir, tFrom, tTo) {
  const side = (t) => cross(lineDir, sub(cubicPoint(P, t), lineP));
  let prevT = tFrom;
  let prevV = side(tFrom);
  if (Math.abs(prevV) < 1e-7) return tFrom;
  const N = 700;
  for (let i = 1; i <= N; i++) {
    const t = tFrom + ((tTo - tFrom) * i) / N;
    const v = side(t);
    if (v === 0 || (v > 0) !== (prevV > 0)) {
      let a = prevT;
      let b = t;
      let va = prevV;
      for (let j = 0; j < 50; j++) {
        const mid = (a + b) / 2;
        const vm = side(mid);
        if ((vm > 0) === (va > 0)) {
          a = mid;
          va = vm;
        } else {
          b = mid;
        }
      }
      return (a + b) / 2;
    }
    prevT = t;
    prevV = v;
  }
  return null;
}

// Tutti i raccordi riconosciuti in un tracciato
export function findFillets(path) {
  const contours = readContours(path);
  const inkSign = inkSignOf(contours);
  const result = [];
  let base = 0;
  contours.forEach((contour, ci) => {
    const info = analyzeContour(contour);
    if (info) {
      for (let k = 0; k < info.segments.length; k++) {
        const g = filletGeometry(info, k, true);
        if (!g) continue;
        result.push({
          ci,
          iA: g.iA,
          abs: [g.iA, g.ih1, g.ih2, g.iB].map((i) => base + i),
          absA: base + g.iA,
          convex: g.cross * inkSign > 0,
          radius: g.radius,
          tension: g.tension,
          collapsed: g.collapsed,
          V: g.V,
          dirIn: g.cornerIn,
          dirOut: g.cornerOut,
          phi: g.phi,
        });
      }
    }
    base += contour.points.length;
  });
  return result;
}

export function targetFillets(path, selection, settings) {
  if (settings.mode === "chamfer") return [];
  let fillets = findFillets(path);
  if (settings.scope === "selection") {
    const sel = selectedPointIndices(selection);
    fillets = fillets.filter((f) => f.abs.some((i) => sel.has(i)));
  }
  if (settings.filter === "convex") fillets = fillets.filter((f) => f.convex);
  if (settings.filter === "concave") fillets = fillets.filter((f) => !f.convex);
  return fillets;
}

// Valore della "fioritura" (blossom) di una cubica: permette di prendere
// qualsiasi tratto [a, b] del polinomio, anche fuori da 0…1 (prolungamento)
function blossom(P, u, v, w) {
  const l1 = [lerp(P[0], P[1], u), lerp(P[1], P[2], u), lerp(P[2], P[3], u)];
  const l2 = [lerp(l1[0], l1[1], v), lerp(l1[1], l1[2], v)];
  return lerp(l2[0], l2[1], w);
}

function subCubic(P, a, b) {
  return [blossom(P, a, a, a), blossom(P, a, a, b), blossom(P, a, b, b), blossom(P, b, b, b)];
}

// Parametro t (anche fuori da 0…1) in cui il polinomio della curva passa per V
function findParamFor(P, V, lo, hi) {
  const N = 600;
  let bestT = null;
  let bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = lo + ((hi - lo) * i) / N;
    const d = vlen(sub(cubicPoint(P, t), V));
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let a = bestT - (hi - lo) / N;
  let b = bestT + (hi - lo) / N;
  for (let i = 0; i < 40; i++) {
    const m1 = a + (b - a) / 3;
    const m2 = b - (b - a) / 3;
    if (vlen(sub(cubicPoint(P, m1), V)) < vlen(sub(cubicPoint(P, m2), V))) b = m2;
    else a = m1;
  }
  const t = (a + b) / 2;
  return vlen(sub(cubicPoint(P, t), V)) < 2 ? t : null;
}

function arcTable(P, t0, t1, steps = 160) {
  const ts = [t0];
  const lengths = [0];
  let prev = cubicPoint(P, t0);
  let total = 0;
  for (let i = 1; i <= steps; i++) {
    const t = t0 + ((t1 - t0) * i) / steps;
    const p = cubicPoint(P, t);
    total += vlen(sub(p, prev));
    ts.push(t);
    lengths.push(total);
    prev = p;
  }
  return { ts, lengths, total };
}

function tAtArc(table, s) {
  const { ts, lengths, total } = table;
  if (s <= 0) return ts[0];
  if (s >= total) return ts[ts.length - 1];
  let lo = 0;
  let hi = lengths.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (lengths[mid] < s) lo = mid;
    else hi = mid;
  }
  const span = lengths[hi] - lengths[lo];
  const f = span > EPS ? (s - lengths[lo]) / span : 0;
  return ts[lo] + (ts[hi] - ts[lo]) * f;
}

// Cambia il raggio dei raccordi indicati (indice locale del nodo A) in un
// contorno. Restituisce { contour, skipped } con lo stesso numero di punti.
export function refilletContour(contour, filletAIndices, opts) {
  const info = analyzeContour(contour);
  if (!info) return null;
  const { segments } = info;
  const rc = !!opts.roundCoords;
  const out = info.pts.map((p) => ({ ...p }));
  const changed = new Set();

  const fillets = new Map();
  segments.forEach((seg, k) => {
    if (seg.kind === "cubic" && filletAIndices.has(seg.a)) {
      const g = filletGeometry(info, k, false);
      if (g && g.phi > 1e-3) fillets.set(k, g);
    }
  });
  if (!fillets.size) return null;

  for (const g of fillets.values()) {
    const phi = Math.min(g.phi, MAX_ANGLE);
    g.d = Math.max(0, opts.radius) * Math.tan(phi / 2);
    g.k = opts.keepTension && Number.isFinite(g.tension) && g.tension > 0 ? g.tension : opts.tension ?? 1;
    // due raccordi attaccati senza un segmento in mezzo: non gestito
    if (fillets.has(g.kin) || fillets.has(g.kout)) g.bad = true;
  }

  // segmenti vicini ai raccordi: inizio e/o fine "agganciati" a uno spigolo V
  const adj = new Map();
  const slot = (s) => {
    if (!adj.has(s)) adj.set(s, { start: null, end: null });
    return adj.get(s);
  };
  for (const g of fillets.values()) {
    if (g.bad) continue;
    slot(g.kin).end = g;
    slot(g.kout).start = g;
  }
  for (const [s, a] of adj) {
    const seg = segments[s];
    const P = segmentPoints(info, seg);
    a.seg = seg;
    a.kind = seg.kind;
    if (seg.kind === "cubic") {
      a.P = P;
      a.t0 = 0;
      a.t1 = 1;
      if (a.start) {
        const t = findParamFor(P, a.start.V, -6, 0.5);
        if (t === null) a.start.bad = true;
        else a.t0 = t;
      }
      if (a.end) {
        const t = findParamFor(P, a.end.V, 0.5, 7);
        if (t === null) a.end.bad = true;
        else a.t1 = t;
      }
    } else if (seg.kind !== "line") {
      if (a.start) a.start.bad = true;
      if (a.end) a.end.bad = true;
    }
    a.P = P;
  }
  // un raccordo "difettoso" non deve muovere niente: ricalcola gli agganci
  for (const a of adj.values()) {
    if (a.start?.bad) a.start = null;
    if (a.end?.bad) a.end = null;
    if (a.kind === "line") {
      a.p0 = a.start ? a.start.V : a.P[0];
      a.p1 = a.end ? a.end.V : a.P[1];
      a.L = vlen(sub(a.p1, a.p0));
    } else if (a.kind === "cubic") {
      if (!a.start) a.t0 = 0;
      if (!a.end) a.t1 = 1;
      a.table = arcTable(a.P, a.t0, a.t1);
      a.L = a.table.total;
    } else {
      a.L = 0;
    }
    const want = (a.start ? a.start.d : 0) + (a.end ? a.end.d : 0);
    a.scale = want > a.L ? (want > EPS ? a.L / want : 1) : 1;
  }
  // ogni raccordo usa la riduzione più forte dei suoi due lati (resta circolare)
  for (const g of fillets.values()) {
    if (g.bad) continue;
    g.dEff = g.d * Math.min(adj.get(g.kin).scale, adj.get(g.kout).scale);
  }

  const setPoint = (i, p) => {
    out[i] = { ...out[i], x: roundValue(p.x, rc), y: roundValue(p.y, rc) };
    changed.add(i);
  };

  // ricostruisce i segmenti vicini
  for (const a of adj.values()) {
    if (!a.start && !a.end) continue;
    if (a.kind === "line") {
      const dir = norm(sub(a.p1, a.p0));
      if (a.start) {
        a.start.B2 = dir ? add(a.p0, mul(dir, a.start.dEff)) : a.p0;
        a.start.dirOut2 = dir || a.start.dirOut;
      }
      if (a.end) {
        a.end.A2 = dir ? sub(a.p1, mul(dir, a.end.dEff)) : a.p1;
        a.end.dirIn2 = dir || a.end.dirIn;
      }
    } else if (a.kind === "cubic") {
      const ta = a.start ? tAtArc(a.table, a.start.dEff) : a.t0;
      const tb = a.end ? tAtArc(a.table, a.L - a.end.dEff) : a.t1;
      const Q = subCubic(a.P, ta, Math.max(ta, tb));
      setPoint(a.seg.offs[0], Q[1]);
      setPoint(a.seg.offs[1], Q[2]);
      if (a.start) {
        a.start.B2 = Q[0];
        a.start.dirOut2 = startTangent(Q) || a.start.dirOut;
      }
      if (a.end) {
        a.end.A2 = Q[3];
        a.end.dirIn2 = endTangent(Q) || a.end.dirIn;
      }
    }
  }

  // riscrive i raccordi
  let done = 0;
  let skipped = 0;
  for (const g of fillets.values()) {
    if (g.bad || !g.A2 || !g.B2) {
      skipped++;
      continue;
    }
    const f = handleFactor(g.phi) * g.k;
    const live = g.dEff > EPS;
    const h1 = add(g.A2, mul(g.dirIn2, g.dEff * f));
    const h2 = sub(g.B2, mul(g.dirOut2, g.dEff * f));
    setPoint(g.iA, g.A2);
    setPoint(g.ih1, h1);
    setPoint(g.ih2, h2);
    setPoint(g.iB, g.B2);
    out[g.iA].smooth = live;
    out[g.iB].smooth = live;
    if (!live) {
      delete out[g.iA].smooth;
      delete out[g.iB].smooth;
    }
    done++;
  }
  if (!done) return { contour: null, skipped };
  return { contour: { points: out, isClosed: contour.isClosed }, skipped };
}

// Applica in un master: prima cambia il raggio dei raccordi esistenti, poi
// arrotonda gli angoli vivi. radius=null → i raccordi esistenti non si toccano
// e gli angoli vivi ricevono raggio 0 (struttura compatibile, aspetto invariato).
export function computeLayerContours(path, sharpByContour, filletsByContour, opts, radius) {
  const result = new Map();
  let skipped = 0;
  const contourIndices = new Set([...sharpByContour.keys(), ...filletsByContour.keys()]);
  for (const ci of contourIndices) {
    let contour = path.getUnpackedContour(ci);
    let touched = false;
    const fl = filletsByContour.get(ci);
    if (fl && radius !== null) {
      const r = refilletContour(contour, fl, { ...opts, radius });
      if (r) {
        skipped += r.skipped;
        if (r.contour) {
          contour = r.contour;
          touched = true;
        }
      }
    }
    const sharp = sharpByContour.get(ci);
    if (sharp) {
      const rounded = roundContour(contour, sharp, { ...opts, radius: radius ?? 0 });
      if (rounded) {
        contour = rounded;
        touched = true;
      }
    }
    if (touched) result.set(ci, contour);
  }
  return { contours: result, skipped };
}

function groupFillets(fillets) {
  const byContour = new Map();
  for (const f of fillets) {
    if (!byContour.has(f.ci)) byContour.set(f.ci, new Set());
    byContour.get(f.ci).add(f.iA);
  }
  return byContour;
}

// ---------------------------------------------------------------------------
// Impostazioni
// ---------------------------------------------------------------------------

function loadSettings() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    return { ...DEFAULTS, ...stored };
  } catch (e) {
    return { ...DEFAULTS };
  }
}

function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch (e) {
    // localStorage non disponibile: le impostazioni valgono solo per questa sessione
  }
}

// ---------------------------------------------------------------------------
// Pannello
// ---------------------------------------------------------------------------

const PANEL_CSS = `
  :host {
    display: block;
    height: 100%;
    color: var(--ui-element-foreground-color, currentColor);
    font-family: fontra-ui-regular, -apple-system, system-ui, sans-serif;
    font-size: 0.95rem;
  }
  .panel {
    display: flex;
    flex-direction: column;
    gap: 0.75em;
    padding: 1em;
    box-sizing: border-box;
    height: 100%;
    overflow: hidden auto;
  }
  .title { font-weight: bold; font-size: 1.05rem; }
  .row { display: flex; flex-direction: column; gap: 0.3em; }
  .label { opacity: 0.75; font-size: 0.85rem; }
  .seg {
    display: grid;
    grid-auto-flow: column;
    grid-auto-columns: 1fr;
    border-radius: 6px;
    overflow: hidden;
    border: 1px solid #8884;
  }
  .seg button {
    font: inherit;
    font-size: 0.85rem;
    padding: 0.35em 0.2em;
    border: none;
    border-left: 1px solid #8884;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .seg button:first-child { border-left: none; }
  .seg button.active { background: #e8590c; color: white; }
  .slider { display: grid; grid-template-columns: 1fr 4.2em; gap: 0.5em; align-items: center; }
  input[type="range"] { width: 100%; accent-color: #e8590c; }
  input[type="number"] {
    font: inherit;
    width: 100%;
    box-sizing: border-box;
    padding: 0.2em 0.35em;
    border-radius: 4px;
    border: 1px solid #8884;
    background: var(--text-input-background-color, transparent);
    color: var(--text-input-foreground-color, inherit);
  }
  .check { display: flex; gap: 0.45em; align-items: center; font-size: 0.85rem; cursor: pointer; }
  .check input { accent-color: #e8590c; margin: 0; }
  .hint { font-size: 0.78rem; opacity: 0.6; line-height: 1.35; }
  .status {
    font-size: 0.85rem;
    padding: 0.5em 0.6em;
    border-radius: 6px;
    background: #8881;
    min-height: 1.3em;
  }
  .status.warn { background: #e8590c22; }
  .buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5em; }
  .buttons button {
    font: inherit;
    padding: 0.5em;
    border-radius: 6px;
    border: 1px solid #8886;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  .buttons button.primary { background: #e8590c; border-color: #e8590c; color: white; font-weight: bold; }
  .buttons button:disabled { opacity: 0.4; cursor: default; }
  .hidden { display: none; }
`;

class AngoliPanel extends HTMLElement {
  constructor() {
    super();
    this.identifier = PANEL_ID;
    this.attachShadow({ mode: "open" });
  }

  setup(plugin, iconPath) {
    this.plugin = plugin;
    this.iconPath = iconPath;
    const s = plugin.settings;
    this.shadowRoot.innerHTML = `
      <style>${PANEL_CSS}</style>
      <div class="panel">
        <div class="title">Angoli</div>

        <div class="row">
          <div class="seg" data-key="mode">
            <button data-value="round">Arrotonda</button>
            <button data-value="chamfer">Smussa</button>
          </div>
        </div>

        <div class="row">
          <div class="label">Raggio</div>
          <div class="slider">
            <input type="range" min="0" max="300" step="1" data-key="radius" />
            <input type="number" min="0" step="1" data-key="radius" />
          </div>
        </div>

        <div class="row" id="tension-row">
          <div class="label">Tensione della curva</div>
          <div class="slider">
            <input type="range" min="0.2" max="1.6" step="0.01" data-key="tension" />
            <input type="number" min="0" max="3" step="0.01" data-key="tension" />
          </div>
          <div class="hint">1 = arco di cerchio · più alto = angolo più “squadrato”</div>
        </div>

        <div class="row">
          <div class="label">Applica a</div>
          <div class="seg" data-key="scope">
            <button data-value="selection">Punti selezionati</button>
            <button data-value="glyph">Tutto il glifo</button>
          </div>
        </div>

        <div class="row">
          <div class="label">Angoli</div>
          <div class="seg" data-key="filter">
            <button data-value="convex">Esterni</button>
            <button data-value="concave">Interni</button>
            <button data-value="both">Tutti</button>
          </div>
        </div>

        <label class="check"><input type="checkbox" data-key="allMasters" /> Stesso raggio in tutti i master</label>
        <div class="hint" id="masters-hint"></div>
        <label class="check"><input type="checkbox" data-key="keepTension" /> Mantieni la tensione degli angoli già arrotondati</label>
        <label class="check"><input type="checkbox" data-key="roundCoords" /> Coordinate intere</label>
        <label class="check"><input type="checkbox" data-key="preview" /> Anteprima sul canvas</label>

        <div class="status" id="status"></div>

        <div class="buttons">
          <button id="select-btn" title="Seleziona gli angoli del glifo che corrispondono al filtro">Seleziona angoli</button>
          <button id="apply-btn" class="primary">Applica</button>
        </div>

        <div class="hint">
          Gli angoli già arrotondati restano angoli: selezionali e cambia il raggio, oppure
          trascina il pallino dentro l'angolo sul canvas (Maiusc = passi da 5).
          Annulla con ⌘Z / Ctrl+Z. Se due contorni si sovrappongono, uniscili prima:
          altrimenti vengono arrotondati anche gli angoli nascosti nella sovrapposizione.
        </div>
      </div>
    `;

    for (const seg of this.shadowRoot.querySelectorAll(".seg")) {
      const key = seg.dataset.key;
      for (const btn of seg.querySelectorAll("button")) {
        btn.addEventListener("click", () => plugin.setSetting(key, btn.dataset.value));
      }
    }
    for (const input of this.shadowRoot.querySelectorAll("input[data-key]")) {
      const key = input.dataset.key;
      if (input.type === "checkbox") {
        input.addEventListener("change", () => plugin.setSetting(key, input.checked));
      } else {
        input.addEventListener("input", () => {
          const v = parseFloat(input.value);
          if (Number.isFinite(v)) plugin.setSetting(key, v);
        });
      }
    }
    this.shadowRoot.querySelector("#apply-btn").addEventListener("click", () => plugin.apply());
    this.shadowRoot.querySelector("#select-btn").addEventListener("click", () => plugin.selectCorners());
    this.renderSettings(s);
  }

  renderSettings(s) {
    for (const seg of this.shadowRoot.querySelectorAll(".seg")) {
      const value = s[seg.dataset.key];
      for (const btn of seg.querySelectorAll("button")) {
        btn.classList.toggle("active", btn.dataset.value === value);
      }
    }
    for (const input of this.shadowRoot.querySelectorAll("input[data-key]")) {
      const value = s[input.dataset.key];
      if (input.type === "checkbox") {
        input.checked = !!value;
      } else if (this.shadowRoot.activeElement !== input) {
        input.value = value;
      }
    }
    this.shadowRoot.querySelector("#tension-row").classList.toggle("hidden", s.mode !== "round");
    this.shadowRoot.querySelector("#masters-hint").textContent = s.allMasters
      ? "Il raggio viene applicato a tutti i master."
      : "Il raggio vale solo per il master su cui ti trovi. Negli altri master i nuovi angoli arrotondati partono con raggio 0 (restano vivi) e li regoli quando ci arrivi.";
  }

  setStatus(text, warn = false) {
    const el = this.shadowRoot.querySelector("#status");
    el.textContent = text;
    el.classList.toggle("warn", warn);
  }

  setButtonsEnabled(applyEnabled, selectEnabled) {
    this.shadowRoot.querySelector("#apply-btn").disabled = !applyEnabled;
    this.shadowRoot.querySelector("#select-btn").disabled = !selectEnabled;
  }

  async toggle(on) {
    this.plugin.setPanelOpen(on);
  }
}

if (!customElements.get(PANEL_TAG)) {
  customElements.define(PANEL_TAG, AngoliPanel);
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

class AngoliPlugin {
  constructor(editor, pluginPath) {
    this.editor = editor;
    this.sceneController = editor.sceneController;
    this.settings = loadSettings();
    this.panelOpen = false;
    this.busy = false;

    this.panel = document.createElement(PANEL_TAG);
    this.panel.setup(this, `${pluginPath}/icon.svg`);
    editor.addSidebarPanel(this.panel, "right");
    const tab = document.querySelector(`.sidebar-tab[data-sidebar-name="${PANEL_ID}"]`);
    this.tab = tab;
    if (tab) {
      tab.title = "Angoli";
      // Fontra non avvisa il pannello quando viene nascosto passando a un'altra
      // scheda: osserviamo direttamente lo stato "selected" della scheda.
      new MutationObserver(() => this.setPanelOpen(this.isPanelVisible())).observe(tab, {
        attributes: true,
        attributeFilter: ["class"],
      });
    }
    this.panelOpen = this.isPanelVisible();

    this.registerPreviewLayer();
    this.setupWidgetDrag();

    const update = () => this.scheduleUpdate();
    this.sceneController.sceneSettingsController.addKeyListener(
      ["selectedGlyph", "selectedGlyphName", "selection"],
      update
    );
    this.sceneController.addCurrentGlyphChangeListener(update);
    this.scheduleUpdate();
  }

  setSetting(key, value) {
    if (key === "radius") value = Math.max(0, value);
    if (key === "tension") value = clamp(value, 0, 3);
    this.settings = { ...this.settings, [key]: value };
    saveSettings(this.settings);
    this.panel.renderSettings(this.settings);
    this.scheduleUpdate();
  }

  isPanelVisible() {
    return !!this.tab?.classList.contains("selected");
  }

  setPanelOpen(on) {
    const open = !!on && this.isPanelVisible();
    if (open === this.panelOpen) return;
    this.panelOpen = open;
    this.scheduleUpdate();
  }

  get options() {
    return {
      mode: this.settings.mode,
      radius: this.settings.radius,
      tension: this.settings.tension,
      roundCoords: this.settings.roundCoords,
      keepTension: this.settings.keepTension,
    };
  }

  getPositionedGlyph() {
    return this.sceneController.sceneModel.getSelectedPositionedGlyph();
  }

  // Angoli vivi
  getTargetCorners(path) {
    return targetCorners(path, this.sceneController.selection, this.settings);
  }

  // Angoli già arrotondati (anche con raggio 0)
  getTargetFillets(path) {
    return targetFillets(path, this.sceneController.selection, this.settings);
  }

  scheduleUpdate() {
    if (this._updatePending) return;
    this._updatePending = true;
    requestAnimationFrame(() => {
      this._updatePending = false;
      this.updateStatus();
      this.editor.canvasController.requestUpdate();
    });
  }

  flashStatus(text, warn = false, ms = 3000) {
    this._flash = { text, warn, until: Date.now() + ms };
    this.panel.setStatus(text, warn);
    setTimeout(() => this.scheduleUpdate(), ms + 50);
  }

  updateStatus() {
    if (this.drag) {
      this.panel.setStatus(`Raggio: ${this.drag.radius}  (rilascia per applicare, Esc per annullare)`);
      return;
    }
    if (this._flash && Date.now() < this._flash.until) {
      this.panel.setStatus(this._flash.text, this._flash.warn);
      this.panel.setButtonsEnabled(!this.busy, true);
      return;
    }
    const positioned = this.getPositionedGlyph();
    const path = positioned?.glyph?.path;
    if (!path) {
      this.panel.setStatus("Seleziona un glifo da modificare.");
      this.panel.setButtonsEnabled(false, false);
      return;
    }
    let corners, fillets;
    try {
      corners = this.getTargetCorners(path);
      fillets = this.getTargetFillets(path);
    } catch (e) {
      console.error("[Angoli]", e);
      this.panel.setStatus("Errore nell'analisi del glifo (vedi console).", true);
      this.panel.setButtonsEnabled(false, false);
      return;
    }
    const total = corners.length + fillets.length;
    const lines = [];
    if (corners.length) {
      const nConvex = corners.filter((c) => c.convex).length;
      const nConcave = corners.length - nConvex;
      const parts = [];
      if (nConvex) parts.push(`${nConvex} ${nConvex === 1 ? "esterno" : "esterni"}`);
      if (nConcave) parts.push(`${nConcave} ${nConcave === 1 ? "interno" : "interni"}`);
      lines.push(`${corners.length} ${corners.length === 1 ? "angolo vivo" : "angoli vivi"} (${parts.join(", ")})`);
    }
    if (fillets.length) {
      const radii = fillets.map((f) => Math.round(f.radius * 10) / 10);
      const lo = Math.min(...radii);
      const hi = Math.max(...radii);
      const r = lo === hi ? `raggio ${lo}` : `raggi da ${lo} a ${hi}`;
      lines.push(
        `${fillets.length} ${fillets.length === 1 ? "angolo arrotondato" : "angoli arrotondati"} (${r} in questo master)`
      );
    }
    let text;
    if (total) {
      text = lines.join(" · ");
    } else if (this.settings.scope === "selection") {
      text = "Nessun angolo tra i punti selezionati. Seleziona dei nodi d'angolo o usa “Tutto il glifo”.";
    } else {
      text = "Nessun angolo che corrisponda al filtro in questo glifo.";
    }
    this.panel.setStatus(text, !total);
    this.panel.setButtonsEnabled(total > 0 && !this.busy, true);
  }

  selectCorners() {
    const positioned = this.getPositionedGlyph();
    const path = positioned?.glyph?.path;
    if (!path) return;
    const all = { ...this.settings, scope: "glyph" };
    const corners = targetCorners(path, null, all);
    const fillets = targetFillets(path, null, all);
    this.sceneController.selection = new Set([
      ...corners.map((c) => `point/${c.abs}`),
      ...fillets.flatMap((f) => f.abs.map((i) => `point/${i}`)),
    ]);
    if (this.settings.scope !== "selection") {
      this.setSetting("scope", "selection");
    }
    this.scheduleUpdate();
  }

  // radiusOverride: raggio scelto trascinando un pallino sul canvas
  async apply(radiusOverride) {
    if (this.busy) return;
    const positioned = this.getPositionedGlyph();
    const primaryPath = positioned?.glyph?.path;
    if (!primaryPath) return;
    const corners = this.getTargetCorners(primaryPath);
    const fillets = this.getTargetFillets(primaryPath);
    if (!corners.length && !fillets.length) return;

    const byContour = groupByContour(corners);
    const filletsByContour = groupFillets(fillets);
    const signature = structureSignature(primaryPath);
    const opts = this.options;
    const radius = radiusOverride ?? opts.radius;
    const glyphName = this.sceneController.sceneModel.getSelectedGlyphName();
    // spigoli coinvolti: servono per riselezionarli dopo la modifica
    const targetVs = [...corners.map((c) => c.V), ...fillets.map((f) => f.V)];

    this.busy = true;
    this.updateStatus();
    let changedLayers = 0;
    let radiusLayerCount = 0;
    let skippedFillets = 0;
    let skippedLayers = [];
    let sourceCount = 0;
    try {
      // Calcolo sui dati reali prima della transazione di modifica
      const varGlyph = await this.editor.fontController.getGlyph(glyphName);
      const realGlyph = varGlyph.glyph;
      // Tutti i master: i nuovi punti vanno aggiunti ovunque, altrimenti i
      // master non sarebbero più compatibili per l'interpolazione.
      let sourceLayers = [...new Set(realGlyph.sources.map((s) => s.layerName))].filter(
        (name) => realGlyph.layers[name]?.glyph?.path
      );
      if (!sourceLayers.length) {
        sourceLayers = [...this.sceneController.editingLayerNames].filter((name) => realGlyph.layers[name]?.glyph?.path);
      }
      sourceCount = sourceLayers.length;
      // Master che ricevono il raggio
      const radiusLayers = new Set(
        this.settings.allMasters
          ? sourceLayers
          : [...this.sceneController.editingLayerNames].filter((name) => sourceLayers.includes(name))
      );
      if (!radiusLayers.size) {
        this.flashStatus(
          "Non sei sulla posizione di un master: spostati su un master oppure attiva “Stesso raggio in tutti i master”.",
          true,
          6000
        );
        return;
      }
      radiusLayerCount = radiusLayers.size;

      const plan = new Map();
      for (const name of sourceLayers) {
        const path = realGlyph.layers[name].glyph.path;
        if (structureSignature(path) !== signature) {
          skippedLayers.push(name);
          continue;
        }
        const r = radiusLayers.has(name) ? radius : null;
        if (r === null && !corners.length) continue; // solo cambio raggio: gli altri master non si toccano
        const { contours, skipped } = computeLayerContours(path, byContour, filletsByContour, opts, r);
        skippedFillets += skipped;
        if (contours.size) plan.set(name, contours);
      }
      if (!plan.size) {
        this.flashStatus("Niente da modificare.", true);
        return;
      }

      const undoLabel =
        opts.mode === "chamfer" ? "Smussa angoli" : corners.length ? "Arrotonda angoli" : "Cambia raggio angoli";
      await this.sceneController.editGlyphAndRecordChanges(
        (glyph) => {
          for (const [name, newContours] of plan) {
            const path = glyph.layers[name].glyph.path;
            for (const [ci, contour] of newContours) {
              path.deleteContour(ci);
              path.insertContour(ci, packContour(contour));
            }
          }
          return undoLabel;
        },
        this,
        true
      );
      changedLayers = plan.size;
      await this.reselectCorners(targetVs, opts.mode !== "chamfer");
    } catch (e) {
      console.error("[Angoli]", e);
      this.flashStatus(`Errore: ${e.message}`, true, 6000);
      return;
    } finally {
      this.busy = false;
    }

    const n = corners.length + fillets.length;
    let msg = `Fatto: ${n} ${n === 1 ? "angolo" : "angoli"}`;
    if (opts.mode !== "chamfer") msg += `, raggio ${Math.round(radius * 10) / 10}`;
    if (radiusLayerCount > 1) msg += ` su ${radiusLayerCount} master`;
    msg += ".";
    if (!this.settings.allMasters && corners.length && sourceCount > 1) {
      msg += " Negli altri master i nuovi angoli partono con raggio 0.";
    }
    if (skippedFillets) {
      msg += ` ${skippedFillets} angoli non modificabili in qualche master (due raccordi attaccati o lato curvo non prolungabile).`;
    }
    if (skippedLayers.length) {
      msg += ` Saltati ${skippedLayers.length} master non compatibili.`;
    }
    this.flashStatus(msg, skippedLayers.length > 0 || skippedFillets > 0);
  }

  // Dopo la modifica riseleziona gli angoli coinvolti (ora arrotondati), così
  // si può continuare a cambiarne il raggio senza riselezionarli a mano.
  async reselectCorners(targetVs, roundMode) {
    if (!roundMode || this.settings.scope !== "selection") {
      this.sceneController.selection = new Set();
      return;
    }
    // la scena di Fontra si aggiorna in modo asincrono: aspettiamo il glifo nuovo
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      const path = this.getPositionedGlyph()?.glyph?.path;
      if (!path) return;
      const found = findFillets(path).filter((f) => targetVs.some((v) => vlen(sub(v, f.V)) < 1.5));
      if (found.length >= targetVs.length || attempt === 19) {
        this.sceneController.selection = new Set(found.flatMap((f) => f.abs.map((i) => `point/${i}`)));
        return;
      }
    }
  }

  registerPreviewLayer() {
    const layers = this.editor.visualizationLayers;
    const defs = layers.definitions;
    if (defs.some((d) => d.identifier === LAYER_ID)) return;
    const plugin = this;
    const def = {
      identifier: LAYER_ID,
      name: "Anteprima angoli",
      selectionFunc: (visContext) => visContext.glyphsBySelectionMode["editing"] || [],
      zIndex: 450,
      screenParameters: { strokeWidth: 1.5, markerRadius: 6, nodeSize: 5, widgetRadius: 5 },
      colors: { strokeColor: "#e8590c", fillColor: "#e8590c22", widgetFill: "#ffffff" },
      colorsDarkMode: { strokeColor: "#ff922b", fillColor: "#ff922b22", widgetFill: "#1e1e1e" },
      draw: (args) => plugin.drawPreview(args),
    };
    let index = defs.findIndex((d) => (d.zIndex ?? 0) > def.zIndex);
    if (index < 0) index = defs.length;
    defs.splice(index, 0, def);
    layers.toggle(LAYER_ID, true);
  }

  drawPreview({ context, positionedGlyph, parameters }) {
    if (!this.isPanelVisible() || this.busy) return;
    const path = positionedGlyph?.glyph?.path;
    if (!path) return;
    let corners, fillets;
    try {
      corners = this.getTargetCorners(path);
      fillets = this.getTargetFillets(path);
    } catch (e) {
      return;
    }
    if (!corners.length && !fillets.length) return;
    const radius = this.drag ? this.drag.radius : this.settings.radius;

    // Contorni risultanti (sempre durante il trascinamento di un pallino)
    if (this.settings.preview || this.drag) {
      let newContours;
      try {
        newContours = computeLayerContours(
          path,
          groupByContour(corners),
          groupFillets(fillets),
          this.options,
          radius
        ).contours;
      } catch (e) {
        newContours = new Map();
      }
      context.beginPath();
      for (let ci = 0; ci < path.numContours; ci++) {
        const contour = newContours.get(ci) || path.getUnpackedContour(ci);
        traceContour(context, contour);
      }
      context.fillStyle = parameters.fillColor;
      context.fill("nonzero");
      context.lineWidth = parameters.strokeWidth;
      context.strokeStyle = parameters.strokeColor;
      context.setLineDash([]);
      context.stroke();

      // Cerchietti sugli angoli vivi coinvolti
      for (const c of corners) {
        context.beginPath();
        context.arc(c.V.x, c.V.y, parameters.markerRadius, 0, 2 * Math.PI);
        context.stroke();
      }
    }

    // Pallini trascinabili (solo arrotondamento, in modalità modifica)
    if (this.settings.mode === "chamfer" || !this.sceneController.sceneModel.selectedGlyph?.isEditing) return;
    const mag = this.editor.canvasController.magnification;
    const widgets = this.computeWidgets(path, mag);
    context.lineWidth = parameters.strokeWidth;
    for (const w of widgets) {
      const r = this.drag ? this.drag.radius : w.radius;
      const pos = this.widgetPosition(w, r, mag);
      // linea guida dallo spigolo durante il trascinamento
      if (this.drag) {
        context.strokeStyle = parameters.strokeColor;
        context.setLineDash([parameters.strokeWidth * 2, parameters.strokeWidth * 2]);
        context.beginPath();
        context.moveTo(w.V.x, w.V.y);
        context.lineTo(pos.x, pos.y);
        context.stroke();
        context.setLineDash([]);
      }
      context.beginPath();
      context.arc(pos.x, pos.y, parameters.widgetRadius, 0, 2 * Math.PI);
      context.fillStyle = parameters.widgetFill;
      context.fill();
      context.strokeStyle = parameters.strokeColor;
      context.stroke();
      context.beginPath();
      context.arc(pos.x, pos.y, parameters.widgetRadius * 0.45, 0, 2 * Math.PI);
      context.fillStyle = parameters.strokeColor;
      context.fill();
    }
  }

  // --- pallini sugli angoli (come i "live corners" di Illustrator) -------------

  // Un pallino per ogni angolo coinvolto, sulla bisettrice all'interno della
  // curva: più lontano dallo spigolo = raggio più grande.
  computeWidgets(path, mag) {
    if (this.settings.mode === "chamfer") return [];
    const corners = this.getTargetCorners(path);
    const fillets = this.getTargetFillets(path);
    const widgets = [];
    for (const c of [...corners.map((c) => ({ ...c, radius: 0 })), ...fillets]) {
      if (!c.dirIn || !c.dirOut) continue;
      const u = norm(sub(c.dirOut, c.dirIn));
      if (!u) continue;
      const phi = Math.min(c.phi, MAX_ANGLE);
      // distanza dallo spigolo del punto medio dell'arco, per unità di raggio
      const fac = 1 / Math.cos(phi / 2) - 1;
      widgets.push({ V: c.V, u, fac: Math.max(fac, 0.02), radius: c.radius, phi });
    }
    return widgets;
  }

  widgetPosition(w, radius, mag) {
    const offset0 = 14 / mag; // il pallino resta visibile anche con raggio 0
    return add(w.V, mul(w.u, offset0 + radius * w.fac));
  }

  glyphPointFromEvent(event) {
    const positioned = this.getPositionedGlyph();
    if (!positioned) return null;
    const p = this.editor.canvasController.localPoint(event);
    return { x: p.x - positioned.x, y: p.y - positioned.y };
  }

  setupWidgetDrag() {
    const canvas = this.editor.canvasController.canvas;
    const swallow = (event) => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };

    window.addEventListener(
      "pointerdown",
      (event) => {
        if (event.target !== canvas || event.button !== 0 || this.busy || this.drag) return;
        if (!this.isPanelVisible() || this.settings.mode === "chamfer") return;
        if (!this.sceneController.sceneModel.selectedGlyph?.isEditing) return;
        const path = this.getPositionedGlyph()?.glyph?.path;
        const p = this.glyphPointFromEvent(event);
        if (!path || !p) return;
        const mag = this.editor.canvasController.magnification;
        let best = null;
        let bestD = (8 + 3) / mag;
        for (const w of this.computeWidgets(path, mag)) {
          const d = vlen(sub(this.widgetPosition(w, w.radius, mag), p));
          if (d < bestD) {
            bestD = d;
            best = w;
          }
        }
        if (!best) return;
        swallow(event); // il clic sul pallino non deve arrivare agli strumenti di Fontra
        this.drag = { widget: best, radius: Math.round(best.radius), moved: false, mag };
        this.scheduleUpdate();
      },
      true
    );

    window.addEventListener(
      "pointermove",
      (event) => {
        if (!this.drag) return;
        swallow(event);
        const p = this.glyphPointFromEvent(event);
        if (!p) return;
        const w = this.drag.widget;
        const s = dot(sub(p, w.V), w.u);
        let r = Math.max(0, (s - 14 / this.drag.mag) / w.fac);
        r = event.shiftKey ? Math.round(r / 5) * 5 : Math.round(r);
        r = Math.min(r, 5000);
        if (r !== this.drag.radius) {
          this.drag.radius = r;
          this.drag.moved = true;
          this.scheduleUpdate();
        }
      },
      true
    );

    const finish = async (event, commit) => {
      if (!this.drag) return;
      swallow(event);
      const { radius, moved } = this.drag;
      this.drag = null;
      if (commit && moved) {
        this.setSetting("radius", radius);
        await this.apply(radius);
      }
      this.scheduleUpdate();
    };
    window.addEventListener("pointerup", (event) => finish(event, true), true);
    window.addEventListener("pointercancel", (event) => finish(event, false), true);
    window.addEventListener(
      "keydown",
      (event) => {
        if (this.drag && event.key === "Escape") finish(event, false);
      },
      true
    );
  }
}

function traceContour(context, contour) {
  const pts = contour.points;
  const n = pts.length;
  if (!n) return;
  let start = pts.findIndex((p) => !isOffCurve(p));
  if (start < 0) return;
  context.moveTo(pts[start].x, pts[start].y);
  const count = contour.isClosed ? n : n - start - 1;
  let buffer = [];
  for (let k = 1; k <= count; k++) {
    const p = pts[(start + k) % n];
    if (isOffCurve(p)) {
      buffer.push(p);
      continue;
    }
    if (buffer.length === 0) {
      context.lineTo(p.x, p.y);
    } else if (buffer.length === 1) {
      context.quadraticCurveTo(buffer[0].x, buffer[0].y, p.x, p.y);
    } else if (buffer.length === 2 && buffer[0].type === "cubic") {
      context.bezierCurveTo(buffer[0].x, buffer[0].y, buffer[1].x, buffer[1].y, p.x, p.y);
    } else {
      // quadratiche implicite (TrueType): punti medi on-curve
      for (let i = 0; i < buffer.length - 1; i++) {
        const mid = lerp(buffer[i], buffer[i + 1], 0.5);
        context.quadraticCurveTo(buffer[i].x, buffer[i].y, mid.x, mid.y);
      }
      const lastOff = buffer[buffer.length - 1];
      context.quadraticCurveTo(lastOff.x, lastOff.y, p.x, p.y);
    }
    buffer = [];
  }
  if (contour.isClosed) context.closePath();
}

// Punto d'ingresso chiamato da Fontra: module[plugin.json.function](editor, pluginPath)
export function start(editor, pluginPath) {
  if (editor.__angoliPlugin) return;
  editor.__angoliPlugin = new AngoliPlugin(editor, pluginPath);
}
