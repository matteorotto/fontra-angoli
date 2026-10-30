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
export function findCorners(path) {
  const contours = readContours(path);
  let biggest = 0;
  let inkSign = 1;
  for (const c of contours) {
    const a = signedArea(c.points);
    if (Math.abs(a) > biggest) {
      biggest = Math.abs(a);
      inkSign = a >= 0 ? 1 : -1;
    }
  }
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
        result.push({ ci, li, abs: base + li, convex: c.cross * inkSign > 0 });
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
      out.push(makePoint(T[0], undefined, isRound, null, true, rc));
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
      out.push(makePoint(S1, undefined, isRound, null, true, rc));
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

        <label class="check"><input type="checkbox" data-key="allMasters" /> Tutti i master (mantiene la compatibilità)</label>
        <label class="check"><input type="checkbox" data-key="roundCoords" /> Coordinate intere</label>
        <label class="check"><input type="checkbox" data-key="preview" /> Anteprima sul canvas</label>

        <div class="status" id="status"></div>

        <div class="buttons">
          <button id="select-btn" title="Seleziona gli angoli del glifo che corrispondono al filtro">Seleziona angoli</button>
          <button id="apply-btn" class="primary">Applica</button>
        </div>

        <div class="hint">
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
    };
  }

  getPositionedGlyph() {
    return this.sceneController.sceneModel.getSelectedPositionedGlyph();
  }

  getTargetCorners(path) {
    return targetCorners(path, this.sceneController.selection, this.settings);
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
    let corners;
    try {
      corners = this.getTargetCorners(path);
    } catch (e) {
      console.error("[Angoli]", e);
      this.panel.setStatus("Errore nell'analisi del glifo (vedi console).", true);
      this.panel.setButtonsEnabled(false, false);
      return;
    }
    const nConvex = corners.filter((c) => c.convex).length;
    const nConcave = corners.length - nConvex;
    let text;
    if (corners.length) {
      const parts = [];
      if (nConvex) parts.push(`${nConvex} ${nConvex === 1 ? "esterno" : "esterni"}`);
      if (nConcave) parts.push(`${nConcave} ${nConcave === 1 ? "interno" : "interni"}`);
      text = `${corners.length} ${corners.length === 1 ? "angolo" : "angoli"} (${parts.join(", ")})`;
    } else if (this.settings.scope === "selection") {
      text = "Nessun angolo tra i punti selezionati. Seleziona dei nodi d'angolo o usa “Tutto il glifo”.";
    } else {
      text = "Nessun angolo che corrisponda al filtro in questo glifo.";
    }
    this.panel.setStatus(text, !corners.length);
    this.panel.setButtonsEnabled(corners.length > 0 && !this.busy, true);
  }

  selectCorners() {
    const positioned = this.getPositionedGlyph();
    const path = positioned?.glyph?.path;
    if (!path) return;
    const corners = targetCorners(path, null, { ...this.settings, scope: "glyph" });
    this.sceneController.selection = new Set(corners.map((c) => `point/${c.abs}`));
    if (this.settings.scope !== "selection") {
      this.setSetting("scope", "selection");
    }
    this.scheduleUpdate();
  }

  async apply() {
    if (this.busy) return;
    const positioned = this.getPositionedGlyph();
    const primaryPath = positioned?.glyph?.path;
    if (!primaryPath) return;
    const corners = this.getTargetCorners(primaryPath);
    if (!corners.length) return;

    const byContour = groupByContour(corners);
    const signature = structureSignature(primaryPath);
    const opts = this.options;
    const glyphName = this.sceneController.sceneModel.getSelectedGlyphName();

    this.busy = true;
    this.updateStatus();
    let changedLayers = 0;
    let skippedLayers = [];
    try {
      // Calcolo sui dati reali prima della transazione di modifica
      const varGlyph = await this.editor.fontController.getGlyph(glyphName);
      const realGlyph = varGlyph.glyph;
      let layerNames;
      if (this.settings.allMasters) {
        layerNames = [...new Set(realGlyph.sources.map((s) => s.layerName))];
      } else {
        layerNames = [...this.sceneController.editingLayerNames];
      }
      layerNames = layerNames.filter((name) => realGlyph.layers[name]?.glyph?.path);

      const plan = new Map();
      for (const name of layerNames) {
        const path = realGlyph.layers[name].glyph.path;
        if (structureSignature(path) !== signature) {
          skippedLayers.push(name);
          continue;
        }
        const newContours = computeRoundedContours(path, byContour, opts);
        if (newContours.size) plan.set(name, newContours);
      }
      if (!plan.size) {
        this.flashStatus("Niente da modificare.", true);
        return;
      }

      const undoLabel = opts.mode === "chamfer" ? "Smussa angoli" : "Arrotonda angoli";
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
      this.sceneController.selection = new Set();
    } catch (e) {
      console.error("[Angoli]", e);
      this.flashStatus(`Errore: ${e.message}`, true, 6000);
      return;
    } finally {
      this.busy = false;
    }

    let msg = `Fatto: ${corners.length} ${corners.length === 1 ? "angolo" : "angoli"}`;
    if (changedLayers > 1) msg += ` su ${changedLayers} master`;
    msg += ".";
    if (skippedLayers.length) {
      msg += ` Saltati ${skippedLayers.length} master non compatibili.`;
    }
    this.flashStatus(msg, skippedLayers.length > 0);
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
      screenParameters: { strokeWidth: 1.5, markerRadius: 6, nodeSize: 5 },
      colors: { strokeColor: "#e8590c", fillColor: "#e8590c22" },
      colorsDarkMode: { strokeColor: "#ff922b", fillColor: "#ff922b22" },
      draw: (args) => plugin.drawPreview(args),
    };
    let index = defs.findIndex((d) => (d.zIndex ?? 0) > def.zIndex);
    if (index < 0) index = defs.length;
    defs.splice(index, 0, def);
    layers.toggle(LAYER_ID, true);
  }

  drawPreview({ context, positionedGlyph, parameters }) {
    if (!this.isPanelVisible() || !this.settings.preview || this.busy) return;
    const path = positionedGlyph?.glyph?.path;
    if (!path) return;
    let corners, newContours;
    try {
      corners = this.getTargetCorners(path);
      if (!corners.length) return;
      newContours = computeRoundedContours(path, groupByContour(corners), this.options);
    } catch (e) {
      return;
    }

    // Contorni risultanti
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

    // Cerchietti sugli angoli coinvolti
    const pointsByContour = [];
    for (let ci = 0; ci < path.numContours; ci++) pointsByContour.push(path.getUnpackedContour(ci).points);
    context.lineWidth = parameters.strokeWidth;
    for (const c of corners) {
      const p = pointsByContour[c.ci][c.li];
      context.beginPath();
      context.arc(p.x, p.y, parameters.markerRadius, 0, 2 * Math.PI);
      context.stroke();
    }
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
