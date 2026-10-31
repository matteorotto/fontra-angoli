// Angoli — plugin per Fontra
// Arrotonda o smussa gli angoli dei contorni, con anteprima live sul canvas.
// Si installa da Impostazioni → Plugin Manager indicando il repository GitHub.

const VERSION = "1.2.0";
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

  let cornerMap = null;
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
      let attrs1 = pts[seg.offs[0]].attrs;
      if (changed && isRound) {
        // lato curvo accorciato: salviamo la sua forma intera (vedi fullSide)
        if (!cornerMap) cornerMap = contourCornerMap(info);
        const P = segData[k].P;
        const S = segData[k].d0 > EPS ? P[0] : cornerMap.get(seg.a) ?? P[0];
        const E = segData[k].d1 > EPS ? P[3] : cornerMap.get(seg.b) ?? P[3];
        attrs1 = { ...(attrs1 || {}), ...sideAttrs(fullSide(P, S, E, attrs1)) };
      }
      out.push(makePoint(T[1], "cubic", false, attrs1, changed, rc));
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
        const rApplied = c.d / Math.tan(Math.min(c.phi, MAX_ANGLE) / 2);
        const cornerV = xy(pts[on[seg.endOn]]);
        const A1 = { x: roundValue(S1.x, rc), y: roundValue(S1.y, rc) };
        const attrs = tagAttrs(rApplied, opts.tension ?? 1, cornerV, A1, c.phi);
        out.push(makePoint(h1, "cubic", false, attrs, true, rc));
        out.push(makePoint(h2, "cubic", false, { ...attrs }, true, rc));
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
  // le estremità di un raccordo non sono angoli vivi, anche se con le
  // coordinate intere il raccordo non è perfettamente tangente
  const filletEnds = new Set();
  for (const f of findFillets(path)) {
    filletEnds.add(f.abs[0]);
    filletEnds.add(f.abs[3]);
  }
  let corners = findCorners(path).filter((c) => !filletEnds.has(c.abs));
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
// Contrassegno invisibile (attributo del punto, salvato nel file) sulle maniglie
// dei raccordi creati dal plugin: li riconosce sempre, anche tra due curve.
const FILLET_TAG = "angoli";
// Nel contrassegno salviamo anche raggio e tensione applicati: con coordinate
// intere e lati curvi la misura geometrica può scostarsi di qualche unità.
// Salviamo anche lo spigolo originale V, come scostamento dal nodo A (così
// resta valido se il glifo viene spostato), e l'angolo di svolta in gradi.
function tagAttrs(radius, tension, V, A, phi) {
  const attrs = { [FILLET_TAG]: 1 };
  if (Number.isFinite(radius)) attrs[`${FILLET_TAG}.r`] = Math.round(radius * 10) / 10;
  if (Number.isFinite(tension)) attrs[`${FILLET_TAG}.t`] = Math.round(tension * 100) / 100;
  if (V && A) {
    attrs[`${FILLET_TAG}.dx`] = Math.round((V.x - A.x) * 100) / 100;
    attrs[`${FILLET_TAG}.dy`] = Math.round((V.y - A.y) * 100) / 100;
  }
  if (Number.isFinite(phi)) attrs[`${FILLET_TAG}.a`] = Math.round(((phi * 180) / Math.PI) * 100) / 100;
  return attrs;
}
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

// Segmento lungo zero (tratto dritto o curva con tutti i punti sovrapposti)
function isDegenerateSegment(P) {
  return P.every((q) => vlen(sub(q, P[0])) < COLLAPSED_TOL);
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
  const degenerateIn = isDegenerateSegment(Pin);
  const degenerateOut = isDegenerateSegment(Pout);
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
  const storedAttrs = info.pts[seg.offs[0]].attrs || {};
  const storedV = storedCorner(storedAttrs, A, B, dirIn, dirOut);
  if (collapsed) {
    V = lerp(A, B, 0.5);
    dA = 0;
    dB = 0;
  } else if (storedV) {
    // spigolo salvato dal plugin: più affidabile del prolungamento delle curve
    V = storedV;
    dA = vlen(sub(V, A));
    dB = vlen(sub(B, V));
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
    } else if (sIn.kind === "cubic" && sOut.kind === "cubic" && !degenerateIn && !degenerateOut) {
      // due lati curvi: lo spigolo è dove si incontrano i prolungamenti delle due curve
      const cc = curveCurveCorner(Pin, Pout, V);
      if (cc) {
        V = cc.V;
        cornerIn = cubicTangent(Pin, cc.t) || dirIn;
        cornerOut = cubicTangent(Pout, cc.s) || dirOut;
        dA = arcTable(Pin, 1, cc.t).total;
        dB = arcTable(Pout, cc.s, 0).total;
      }
    }
  }
  const storedPhi = storedAttrs[`${FILLET_TAG}.a`];
  const phi =
    (storedV || collapsed) && Number.isFinite(storedPhi)
      ? (storedPhi * Math.PI) / 180
      : angleBetween(cornerIn, cornerOut);

  const tagged = !!(info.pts[seg.offs[0]].attrs?.[FILLET_TAG] || info.pts[seg.offs[1]].attrs?.[FILLET_TAG]);

  if (strict) {
    // un lato curvo salvato dal plugin (anche se ridotto a lunghezza zero) non è un raccordo
    if (Number.isFinite(info.pts[seg.offs[0]].attrs?.[`${FILLET_TAG}.s1x`])) return null;
    // un raccordo "chiuso" senza contrassegno accanto a lati curvi è ambiguo
    if (collapsed && !tagged && (sIn.kind !== "line" || sOut.kind !== "line")) return null;
    if (phi < FILLET_MIN_ANGLE || phi > FILLET_MAX_ANGLE) return null;
    if (!collapsed) {
      // Con coordinate intere le maniglie corte risultano un po' inclinate:
      // la tolleranza cresce quando la maniglia è corta (errore di ±0,5 unità).
      const l1 = vlen(sub(h1, A));
      const l2 = vlen(sub(B, h2));
      const tiny = vlen(sub(B, A)) < 3; // raccordo minuscolo: le direzioni non sono affidabili
      const t1 = norm(sub(h1, A)) || norm(sub(h2, A));
      const t2 = norm(sub(B, h2)) || norm(sub(B, h1));
      if (!tiny) {
        if (!t1 || !t2) return null;
        const extra = tagged ? (10 * Math.PI) / 180 : 0;
        const tol1 = FILLET_TANGENT_TOL + extra + Math.atan(1.2 / Math.max(l1 || vlen(sub(h2, A)), 0.5));
        const tol2 = FILLET_TANGENT_TOL + extra + Math.atan(1.2 / Math.max(l2 || vlen(sub(B, h1)), 0.5));
        if (angleBetween(dirIn, t1) > tol1) return null;
        if (angleBetween(t2, dirOut) > tol2) return null;
      }
      if (dA < -1.5 || dB < -1.5) return null;
      if (l1 > dA + 2 || l2 > dB + 2) return null;
      const lo = Math.max(Math.min(dA, dB), 1.5);
      if (!tagged && Math.max(dA, dB) / lo > 3) return null; // troppo asimmetrico per essere un raccordo
      // Due lati curvi e nessun contrassegno: lo accettiamo solo se è piccolo
      // rispetto alle curve vicine e ha la forma di un raccordo, così le curve
      // normali (es. i quarti di un cerchio) non diventano "angoli".
      if (!tagged && sIn.kind !== "line" && sOut.kind !== "line") {
        // il lato rimasto tra due raccordi del plugin non è a sua volta un raccordo
        const isTaggedSeg = (sg) => sg.kind === "cubic" && sg.offs.some((i) => info.pts[i].attrs?.[FILLET_TAG]);
        if (isTaggedSeg(sIn) || isTaggedSeg(sOut)) return null;
        const near = Math.min(segmentLength(Pin), segmentLength(Pout));
        if (Math.max(dA, dB) > 0.35 * near) return null;
        const ratio = ((dA > EPS ? l1 / dA : 0) + (dB > EPS ? l2 / dB : 0)) / 2 / handleFactor(phi);
        if (ratio < 0.5 || ratio > 1.7) return null;
      }
    }
  }

  const d = Math.max(0, (dA + dB) / 2);
  const halfTan = Math.tan(Math.min(phi, MAX_ANGLE) / 2);
  let radius = halfTan > EPS ? d / halfTan : 0;
  let tension = null;
  if (!collapsed && dA > EPS && dB > EPS) {
    const ratio = (vlen(sub(h1, A)) / dA + vlen(sub(h2, B)) / dB) / 2;
    tension = ratio / handleFactor(phi);
  }
  // valori salvati nel contrassegno: li usiamo se la forma non è stata
  // cambiata a mano (misura vicina a quanto salvato)
  const stored = info.pts[seg.offs[0]].attrs || {};
  const rStored = stored[`${FILLET_TAG}.r`];
  const tStored = stored[`${FILLET_TAG}.t`];
  if (Number.isFinite(rStored) && Math.abs(radius - rStored) <= Math.max(2, 0.15 * rStored)) radius = rStored;
  if (Number.isFinite(tStored) && tension !== null && Math.abs(tension - tStored) <= 0.15) tension = tStored;
  return {
    k, kin, kout, V, dirIn, dirOut, cornerIn, cornerOut, phi, dA, dB, radius, tension, collapsed, tagged,
    iA: seg.a, ih1: seg.offs[0], ih2: seg.offs[1], iB: seg.b,
    cross: cross(cornerIn, cornerOut),
  };
}

// Parametro del punto del polinomio (anche prolungato) più vicino a V
function nearestParam(P, V, lo, hi) {
  const N = 300;
  let bestT = lo;
  let bestD = Infinity;
  for (let i = 0; i <= N; i++) {
    const t = lo + ((hi - lo) * i) / N;
    const d = vlen(sub(cubicPoint(P, t), V));
    if (d < bestD) {
      bestD = d;
      bestT = t;
    }
  }
  let a = Math.max(lo, bestT - (hi - lo) / N);
  let b = Math.min(hi, bestT + (hi - lo) / N);
  for (let i = 0; i < 40; i++) {
    const m1 = a + (b - a) / 3;
    const m2 = b - (b - a) / 3;
    if (vlen(sub(cubicPoint(P, m1), V)) < vlen(sub(cubicPoint(P, m2), V))) b = m2;
    else a = m1;
  }
  return (a + b) / 2;
}

// Incrocio tra il prolungamento della curva che arriva (oltre t=1) e quello
// della curva che riparte (prima di t=0), partendo da una stima V0
function curveCurveCorner(Pin, Pout, V0) {
  let t = nearestParam(Pin, V0, 1, 5);
  let s = nearestParam(Pout, V0, -4, 0);
  for (let i = 0; i < 40; i++) {
    s = nearestParam(Pout, cubicPoint(Pin, t), -4, 0);
    t = nearestParam(Pin, cubicPoint(Pout, s), 1, 5);
  }
  const p = cubicPoint(Pin, t);
  const q = cubicPoint(Pout, s);
  const gap = vlen(sub(p, q));
  const scale = Math.max(vlen(sub(V0, Pin[3])), vlen(sub(V0, Pout[0])), 1);
  if (gap > Math.max(4, 0.25 * scale)) return null;
  return { V: lerp(p, q, 0.5), t, s };
}

// Spigolo salvato nel contrassegno, se è ancora coerente con la forma attuale
// (stesso lato del nodo A e del nodo B, vicino alle loro tangenti)
function storedCorner(attrs, A, B, dirIn, dirOut) {
  const dx = attrs[`${FILLET_TAG}.dx`];
  const dy = attrs[`${FILLET_TAG}.dy`];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;
  const V = { x: A.x + dx, y: A.y + dy };
  const tol = Math.max(2, 0.12 * (vlen(sub(V, A)) + vlen(sub(B, V))));
  if (Math.abs(cross(dirIn, sub(V, A))) > tol) return null;
  if (Math.abs(cross(dirOut, sub(B, V))) > tol) return null;
  if (dot(sub(V, A), dirIn) < -1 || dot(sub(B, V), dirOut) < -1) return null;
  return V;
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
          tagged: g.tagged,
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
function findParamFor(P, V, lo, hi, tol = 2) {
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
  return vlen(sub(cubicPoint(P, t), V)) < tol ? t : null;
}

// Tolleranza per ritrovare lo spigolo sul prolungamento di una curva: le
// coordinate intere spostano un po' il polinomio, e il prolungamento amplifica
// l'errore tanto più quanto è lungo.
function extensionTolerance(P, V, endIndex) {
  // un tratto corto che ha perso la sua leggera curvatura con le coordinate
  // intere, prolungato, passa a qualche unità dallo spigolo: lo accettiamo
  return Math.max(4, 0.3 * vlen(sub(V, P[endIndex])));
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

// --- Lati curvi accanto ai raccordi -----------------------------------------
// La prima volta che un raccordo accorcia un lato curvo, salviamo nel
// contrassegno la forma intera del lato, da spigolo S a spigolo E, come
// scostamenti delle maniglie da S ed E. Ogni cambio di raggio ritaglia quel
// lato originale: la bombatura non si perde, anche con coordinate intere.

function sideAttrs(F) {
  const r2 = (v) => Math.round(v * 100) / 100;
  return {
    [`${FILLET_TAG}.s1x`]: r2(F[1].x - F[0].x),
    [`${FILLET_TAG}.s1y`]: r2(F[1].y - F[0].y),
    [`${FILLET_TAG}.s2x`]: r2(F[2].x - F[3].x),
    [`${FILLET_TAG}.s2y`]: r2(F[2].y - F[3].y),
  };
}

function distToCurve(F, p) {
  return vlen(sub(cubicPoint(F, nearestParam(F, p, -0.15, 1.15)), p));
}

// Lato originale salvato, se è coerente con la curva attuale P e con gli spigoli S, E
function storedSide(P, S, E, attrs) {
  const k = (n) => attrs?.[`${FILLET_TAG}.${n}`];
  if (![k("s1x"), k("s1y"), k("s2x"), k("s2y")].every(Number.isFinite)) return null;
  const F = [xy(S), { x: S.x + k("s1x"), y: S.y + k("s1y") }, { x: E.x + k("s2x"), y: E.y + k("s2y") }, xy(E)];
  const tol = Math.max(2, 0.02 * vlen(sub(E, S)));
  if (distToCurve(F, P[0]) > tol || distToCurve(F, P[3]) > tol) return null;
  return F;
}

// Lato intero da S a E: quello salvato, oppure ricostruito dalla curva attuale
function fullSide(P, S, E, attrs) {
  const stored = storedSide(P, S, E, attrs);
  if (stored) return stored;
  let F = P.map(xy);
  if (vlen(sub(E, F[3])) > EPS) F = adjustCurveEnd(F, E, 0);
  if (vlen(sub(S, F[0])) > EPS) F = adjustCurveStart(F, S, 0);
  return F;
}

// Spigolo di ogni raccordo del contorno, per indice del suo nodo A e del nodo B
function contourCornerMap(info) {
  const map = new Map();
  info.segments.forEach((seg, k) => {
    if (seg.kind !== "cubic") return;
    const tagged = seg.offs.some((i) => info.pts[i].attrs?.[FILLET_TAG]);
    const g = filletGeometry(info, k, true) || (tagged ? filletGeometry(info, k, false) : null);
    if (!g) return;
    map.set(g.iA, g.V);
    map.set(g.iB, g.V);
  });
  return map;
}

// Sposta la fine di una curva (P[3]) in modo che tra la nuova fine e lo
// spigolo V resti la distanza d misurata lungo il lato.
function adjustCurveEnd(P, V, d) {
  const A = P[3];
  // 1) se il prolungamento del polinomio arriva davvero allo spigolo (curve
  //    con coordinate non arrotondate), è il modo esatto
  const tV = findParamFor(P, V, 0.5, 7, 0.5);
  if (tV !== null && tV >= 1 - 1e-6) {
    const table = arcTable(P, 0, tV);
    return subCubic(P, 0, tAtArc(table, Math.max(0, table.total - d)));
  }
  const gap = vlen(sub(V, A));
  if (d >= gap) {
    // 2) raggio più grande: si taglia dentro la curva (esatto)
    const table = arcTable(P, 0, 1);
    return subCubic(P, 0, tAtArc(table, Math.max(0, table.total - (d - gap))));
  }
  // 3) raggio più piccolo: la fine scivola verso lo spigolo e la curva viene
  //    "stirata" lungo la sua corda, così la bombatura del lato resta la stessa
  const u = norm(sub(V, A)) || endTangent(P);
  if (!u) return P.map(xy);
  const A2 = add(A, mul(u, gap - d));
  return stretchCurve(P, A2);
}

// Trasforma la curva in modo che la fine passi da P[3] ad A2 tenendo fermo
// l'inizio: le distanze lungo la corda si allungano, quelle perpendicolari
// (la bombatura) restano uguali.
function stretchCurve(P, A2) {
  const c0 = P[0];
  const chord = sub(P[3], c0);
  const L = vlen(chord);
  const newChord = sub(A2, c0);
  const L2 = vlen(newChord);
  if (L < EPS || L2 < EPS) {
    const delta = sub(A2, P[3]);
    return [xy(P[0]), xy(P[1]), add(P[2], delta), xy(A2)];
  }
  const e = mul(chord, 1 / L);
  const n = { x: -e.y, y: e.x };
  const e2 = mul(newChord, 1 / L2);
  const n2 = { x: -e2.y, y: e2.x };
  const scale = L2 / L;
  const map = (p) => {
    const v = sub(p, c0);
    return add(c0, add(mul(e2, dot(v, e) * scale), mul(n2, dot(v, n))));
  };
  return [xy(P[0]), map(P[1]), map(P[2]), xy(A2)];
}

function adjustCurveStart(P, V, d) {
  return adjustCurveEnd([...P].reverse(), V, d).reverse();
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
    if (fillets.has(g.kin) || fillets.has(g.kout)) g.bad = "attached";
  }

  // segmenti vicini ai raccordi: inizio e/o fine "agganciati" a uno spigolo V
  let cornerMap = null;
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
    // una curva lunga zero (es. un raccordo con raggio 0 accanto) si tratta come un tratto dritto
    if (seg.kind === "cubic" && isDegenerateSegment(P)) a.kind = "line-degenerate";
    if (a.kind !== "cubic" && a.kind !== "line" && a.kind !== "line-degenerate") {
      if (a.start) a.start.bad = "other-seg";
      if (a.end) a.end.bad = "other-seg";
    }
    a.P = P;
  }
  // un raccordo "difettoso" non deve muovere niente: ricalcola gli agganci
  for (const a of adj.values()) {
    if (a.start?.bad) a.start = null;
    if (a.end?.bad) a.end = null;
    if (a.kind === "line" || a.kind === "line-degenerate") {
      a.p0 = a.start ? a.start.V : a.P[0];
      a.p1 = a.end ? a.end.V : a.P[a.P.length - 1];
      a.L = vlen(sub(a.p1, a.p0));
    } else if (a.kind === "cubic") {
      // lato intero da spigolo a spigolo (salvato o ricostruito)
      if (!cornerMap) cornerMap = contourCornerMap(info);
      const S = a.start ? a.start.V : cornerMap.get(a.seg.a) ?? a.P[0];
      const E = a.end ? a.end.V : cornerMap.get(a.seg.b) ?? a.P[3];
      a.F = fullSide(a.P, S, E, info.pts[a.seg.offs[0]].attrs);
      // tratto utilizzabile: dagli spigoli dei raccordi coinvolti, o dalle
      // estremità attuali dove il raccordo vicino non cambia
      a.tLo = a.start ? 0 : nearestParam(a.F, a.P[0], -0.15, 1.15);
      a.tHi = a.end ? 1 : nearestParam(a.F, a.P[3], -0.15, 1.15);
      a.table = arcTable(a.F, a.tLo, Math.max(a.tLo, a.tHi));
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
    if (a.kind === "line" || a.kind === "line-degenerate") {
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
      const t0 = a.start ? tAtArc(a.table, a.start.dEff) : a.tLo;
      const t1 = a.end ? tAtArc(a.table, a.L - a.end.dEff) : a.tHi;
      const Q = subCubic(a.F, t0, Math.max(t0, t1));
      // estremità che non cambiano restano esattamente dove sono
      if (!a.start) Q[0] = xy(a.P[0]);
      if (!a.end) Q[3] = xy(a.P[3]);
      setPoint(a.seg.offs[0], Q[1]);
      setPoint(a.seg.offs[1], Q[2]);
      out[a.seg.offs[0]].attrs = { ...(out[a.seg.offs[0]].attrs || {}), ...sideAttrs(a.F) };
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
  const reasons = [];
  for (const g of fillets.values()) {
    if (g.bad || !g.A2 || !g.B2) {
      skipped++;
      reasons.push(g.bad || "no-anchor");
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
    const rApplied = g.dEff / Math.tan(Math.min(g.phi, MAX_ANGLE) / 2);
    const attrs = tagAttrs(rApplied, g.k, g.V, out[g.iA], g.phi);
    out[g.ih1].attrs = { ...(out[g.ih1].attrs || {}), ...attrs };
    out[g.ih2].attrs = { ...(out[g.ih2].attrs || {}), ...attrs };
    out[g.iA].smooth = live;
    out[g.iB].smooth = live;
    if (!live) {
      delete out[g.iA].smooth;
      delete out[g.iB].smooth;
    }
    done++;
  }
  if (!done) return { contour: null, skipped, reasons };
  return { contour: { points: out, isClosed: contour.isClosed }, skipped, reasons };
}

// Raggio massimo "utile" di un angolo: oltre questo valore il raccordo
// occuperebbe tutto lo spazio disponibile sui lati e non cambierebbe più.
// target: angolo vivo { ci, li } oppure raccordo { ci, iA }.
export function cornerMaxRadius(path, target) {
  const info = analyzeContour(path.getUnpackedContour(target.ci));
  if (!info) return 0;
  let phi, capIn, capOut;
  if (target.iA === undefined) {
    const j = info.on.indexOf(target.li);
    const c = j >= 0 ? cornerAt(info, j) : null;
    if (!c) return 0;
    phi = c.phi;
    capIn = segmentLength(segmentPoints(info, info.segments[c.kin]));
    capOut = segmentLength(segmentPoints(info, info.segments[c.kout]));
  } else {
    const k = info.segments.findIndex((seg) => seg.kind === "cubic" && seg.a === target.iA);
    const g = k >= 0 ? filletGeometry(info, k, false) : null;
    if (!g) return 0;
    phi = g.phi;
    const Pin = segmentPoints(info, info.segments[g.kin]);
    const Pout = segmentPoints(info, info.segments[g.kout]);
    capIn = info.segments[g.kin].kind === "line" ? vlen(sub(g.V, Pin[0])) : segmentLength(Pin) + Math.max(0, g.dA);
    capOut =
      info.segments[g.kout].kind === "line"
        ? vlen(sub(Pout[Pout.length - 1], g.V))
        : segmentLength(Pout) + Math.max(0, g.dB);
  }
  const halfTan = Math.tan(Math.min(phi, MAX_ANGLE) / 2);
  if (halfTan < EPS) return 0;
  return Math.min(capIn, capOut) / halfTan;
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
  .ver { font-weight: normal; font-size: 0.75rem; opacity: 0.5; margin-left: 0.4em; }
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
        <div class="title">Angoli<span class="ver">v${VERSION}</span></div>

        <div class="row">
          <div class="seg" data-key="mode">
            <button data-value="round">Arrotonda</button>
            <button data-value="chamfer">Smussa</button>
          </div>
        </div>

        <div class="row">
          <div class="label">Raggio</div>
          <div class="slider">
            <input type="range" min="0" max="1000" step="1" data-key="radiusSlider" />
            <input type="number" min="0" step="1" data-key="radius" />
          </div>
          <div class="hint" id="radius-hint"></div>
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
        <label class="check"><input type="checkbox" data-key="keepTension" /> Mantieni la tensione degli angoli già arrotondati (finché non sposti lo slider della tensione)</label>
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
          if (!Number.isFinite(v)) return;
          if (key === "radiusSlider") plugin.setSetting("radius", plugin.sliderToRadius(v));
          else plugin.setSetting(key, v);
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
      } else if (input.dataset.key === "radiusSlider") {
        if (this.shadowRoot.activeElement !== input) input.value = this.plugin.radiusToSlider(s.radius);
      } else if (this.shadowRoot.activeElement !== input) {
        input.value = value;
      }
    }
    this.shadowRoot.querySelector("#tension-row").classList.toggle("hidden", s.mode !== "round");
    this.shadowRoot.querySelector("#radius-hint").textContent = this.plugin.radiusHint || "";
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
    this.radiusMax = 300; // fondo scala dello slider, adattato agli angoli coinvolti
    this.radiusHint = "";
    // true quando hai spostato lo slider della tensione: da lì in poi la
    // tensione del pannello vale anche per gli angoli già arrotondati
    this.tensionDirty = false;
    this._syncKey = null;

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
    if (key === "tension") {
      value = clamp(value, 0, 3);
      if (!this._syncing) this.tensionDirty = true;
    }
    this.settings = { ...this.settings, [key]: value };
    saveSettings(this.settings);
    this.panel.renderSettings(this.settings);
    this.scheduleUpdate();
  }

  // Slider progressivo: preciso sui raggi piccoli, ma arriva fino al massimo utile
  sliderToRadius(p) {
    return Math.round(this.radiusMax * Math.pow(clamp(p, 0, 1000) / 1000, 2));
  }

  radiusToSlider(r) {
    return Math.round(1000 * Math.sqrt(clamp(r / this.radiusMax, 0, 1)));
  }

  updateRadiusRange(path, corners, fillets) {
    let max = 0;
    for (const t of [...corners, ...fillets]) {
      try {
        max = Math.max(max, cornerMaxRadius(path, t));
      } catch (e) {
        // ignora
      }
    }
    max = Math.min(max, 5000);
    const newMax = max > 0 ? Math.max(20, Math.ceil(max)) : Math.max(300, Math.ceil(this.settings.radius));
    this.radiusHint = max > 0 ? `Raggio massimo utile per questi angoli: ${Math.floor(max)}` : "";
    if (newMax !== this.radiusMax || this._lastHint !== this.radiusHint) {
      this.radiusMax = newMax;
      this._lastHint = this.radiusHint;
      this.panel.renderSettings(this.settings);
    }
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
      keepTension: this.settings.keepTension && !this.tensionDirty,
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
      const max = this.drag.widget.rMax > 0 ? Math.ceil(this.drag.widget.rMax) : null;
      const atMax = max !== null && this.drag.radius >= max;
      this.panel.setStatus(
        `Raggio: ${this.drag.radius}${atMax ? " (massimo)" : ""}  · rilascia per applicare, Esc per annullare`
      );
      return;
    }
    const flashing = this._flash && Date.now() < this._flash.until;
    const positioned = this.getPositionedGlyph();
    const path = positioned?.glyph?.path;
    if (!path) {
      this.panel.setStatus(flashing ? this._flash.text : "Seleziona un glifo da modificare.", flashing && this._flash.warn);
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
    // anche mentre è visibile il messaggio "Fatto…", raggio e tensione nel
    // pannello seguono subito la nuova selezione
    this.updateRadiusRange(path, corners, fillets);
    this.syncFromSelection(corners, fillets);
    if (flashing) {
      this.panel.setStatus(this._flash.text, this._flash.warn);
      this.panel.setButtonsEnabled(!this.busy && corners.length + fillets.length > 0, true);
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
      text = this.explainEmptySelection(path);
    } else {
      text = "Nessun angolo che corrisponda al filtro in questo glifo.";
    }
    this.panel.setStatus(text, !total);
    this.panel.setButtonsEnabled(total > 0 && !this.busy, true);
  }

  // Quando cambia la selezione, raggio e tensione nel pannello mostrano i
  // valori attuali degli angoli arrotondati selezionati (come in Illustrator)
  syncFromSelection(corners, fillets) {
    if (this.drag || this.busy) return;
    const glyphName = this.sceneController.sceneModel.getSelectedGlyphName?.() || "";
    const key = `${glyphName}:${corners.map((c) => c.abs).join(",")}:${fillets.map((f) => f.absA).join(",")}`;
    if (key === this._syncKey) return;
    this._syncKey = key;
    this.tensionDirty = false;
    if (!fillets.length) return;
    const radii = fillets.map((f) => f.radius);
    const tensions = fillets.map((f) => f.tension).filter((t) => Number.isFinite(t));
    this._syncing = true;
    try {
      if (Math.max(...radii) - Math.min(...radii) <= 0.5) {
        this.settings = { ...this.settings, radius: Math.round(radii[0] * 10) / 10 };
      }
      if (tensions.length && Math.max(...tensions) - Math.min(...tensions) <= 0.02) {
        this.settings = { ...this.settings, tension: Math.round(tensions[0] * 100) / 100 };
      }
      saveSettings(this.settings);
      this.panel.renderSettings(this.settings);
    } finally {
      this._syncing = false;
    }
  }

  // Spiega perché i punti selezionati non danno nessun angolo da modificare
  explainEmptySelection(path) {
    const sel = this.sceneController.selection;
    if (!sel || !sel.size) {
      return "Seleziona gli angoli da modificare (anche solo un punto dell'angolo arrotondato), oppure usa “Tutto il glifo”.";
    }
    const anyFilter = { ...this.settings, filter: "both", mode: "round" };
    const corners = targetCorners(path, sel, anyFilter);
    const fillets = targetFillets(path, sel, anyFilter);
    if (this.settings.mode === "chamfer" && fillets.length) {
      return "Tra i punti selezionati ci sono angoli arrotondati, ma in modalità “Smussa” non si modificano: passa ad “Arrotonda”.";
    }
    const all = [...corners, ...fillets];
    if (all.length) {
      const kind = all.every((c) => c.convex) ? "esterni" : all.every((c) => !c.convex) ? "interni" : "esterni e interni";
      const filterName = this.settings.filter === "convex" ? "Esterni" : "Interni";
      return `I punti selezionati sono angoli ${kind}, ma il filtro “${filterName}” li esclude: scegli “Tutti”.`;
    }
    return "Nei punti selezionati non riconosco nessun angolo. Seleziona un nodo d'angolo o un punto di un angolo arrotondato (con almeno un lato dritto), oppure usa “Tutto il glifo”.";
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
      // con coordinate intere lo spigolo ricalcolato si sposta di poco
      const all = findFillets(path);
      const found = [];
      for (const v of targetVs) {
        let best = null;
        let bestD = Infinity;
        for (const f of all) {
          const d = vlen(sub(v, f.V));
          if (d < bestD) {
            bestD = d;
            best = f;
          }
        }
        if (best && bestD < Math.max(3, 0.25 * best.radius) && !found.includes(best)) found.push(best);
      }
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
      let rMax = 0;
      try {
        rMax = cornerMaxRadius(path, c);
      } catch (e) {
        rMax = 0;
      }
      // sugli angoli molto aperti la distanza reale cambierebbe pochissimo:
      // un minimo di sensibilità rende il trascinamento controllabile
      widgets.push({ V: c.V, u, fac: Math.max(fac, 0.12), radius: c.radius, phi, rMax });
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
        if (w.rMax > 0) r = Math.min(r, Math.ceil(w.rMax)); // oltre non cambierebbe niente
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
  console.info(`[Angoli] versione ${VERSION} caricata da ${pluginPath}`);
  editor.__angoliPlugin = new AngoliPlugin(editor, pluginPath);
}
