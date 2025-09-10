import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import durations from "../data/durations.json";
import "../styles/timeline.css";
import TextCard from "./textCard";

/* ===== BCE/CE helpers (no year 0) ===== */
const toAstronomical = (y) => (y <= 0 ? y + 1 : y);
const fromAstronomical = (a) => (a <= 0 ? a - 1 : a);
const formatYear = (y) => (y < 0 ? `${Math.abs(y)} BCE` : y > 0 ? `${y} CE` : "—");

/* ===== Colors for Symbolic Systems ===== */
const SymbolicSystemColorPairs = {
  Sumerian: "#000000ff",
  Akkadian: "#10B981",
  Egyptian: "#fd0d00ff",
  "Ancient Egyptian": "#fd0d00ff",
  Hittite: "#d000ffff",
  Hurrian: "#000000",
  Yahwistic: "#0000FF",
  Canaanite: "#FFA500",
  Aramaic: "#ff00eeff",
  Elamite: "#06930bff",
  Zoroastrian: "#0000FF",
  Hellenic: "#1102e7ff",
  Mycenaean: "#000000ff",
  Orphic: "#BE185D"
};

/* ===== Label sizing vs zoom ===== */
const LABEL_BASE_PX = 11;

// Label sizing vs band height (works for hRel or absolute heights)
// Label size as a fraction of the rendered band height (post-zoom)
const LABEL_TO_BAND = 0.7;     // 0.30–0.45 works well
const LABEL_FONT_MIN = 8;       // px clamp (tiny bands)
const LABEL_FONT_MAX_ABS = 160; // px safety cap for extreme zoom
const LABEL_FONT_MAX_REL = 0.9; // never exceed 90% of band height

/* ===== Render + hover constants ===== */
const BASE_OPACITY = 0.3;
const TEXT_BASE_R = 0.4;       // at k=1
const HOVER_SCALE_DOT = 1.6;   // how much bigger a dot gets on hover
const ZOOM_THRESHOLD = 1.7;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* --- Opacity/width levels for duration label + border --- */
const DUR_LABEL_OPACITY = { base: 0.3, hover: 0.75, active: 1 };
const DUR_STROKE = {
  baseOpacity: 0.08, hoverOpacity: 0.45, activeOpacity: 0.9,
  baseWidth: 1.5,    hoverWidth: 2.0,    activeWidth: 2.5,
};

/* ===== Label visibility policy ===== */
const LABEL_ALLOWLIST = new Set([
  "egyptian-composite", "mesopotamian-composite", "anatolian-composite", "west-semitic-composite", "1stpersian-composite", 
  "greek-composite"
]);

const LABEL_BLOCKLIST = new Set([
  "customgroup-hellenistic"
]);

const MIN_BAND_HEIGHT_FOR_LABEL = 14;  // px
const MIN_BAND_WIDTH_FOR_LABEL  = 48;  // px
const ZOOM_TO_FORCE_LABEL       = 3.0; // non-allowlisted labels show only past this zoom


/* ===== Tooltip helpers ===== */
const fmtRange = (s, e) => `${formatYear(s)} – ${formatYear(e)}`;
// Now supports an optional third line for "note"
const tipHTML = (title, subtitle, note) => `
  <div class="tl-tip-title">${title ?? ""}</div>
  ${subtitle ? `<div class="tl-tip-sub">${subtitle}</div>` : ""}
  ${note ? `<div class="tl-tip-note">${note}</div>` : ""}
`;

/* ===== Small utils ===== */
const hashString = (str) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < (str || "").length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32;
};
function getTextDate(row) {
  const v = Number(row?.["Dataviz date"]);
  return Number.isFinite(v) ? v : NaN;
}
function pickSystemColors(tagsStr) {
  const seen = new Set();
  const out = [];
  String(tagsStr)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((tag) => {
      const c = SymbolicSystemColorPairs[tag];
      if (c && !seen.has(tag)) {
        seen.add(tag);
        out.push(c);
      }
    });
  return out;
}

function pickSystemColor(tagsStr) {
  const arr = pickSystemColors(tagsStr);
  return arr[0] || "#444";
}

const normalizeAuthor = (name) =>
  String(name || "anon").trim().toLowerCase();

/* === NEW: detect placeholder/unknown authors === */
const isPlaceholderAuthor = (name) => {
  const raw = String(name || "").trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  return (
    raw === "-" ||
    raw === "—" 
  );
};

/* ===== Custom-group helpers ===== */
// custom ids look like: custom-<groupKey>-<anything>-composite
function parseCustomId(id = "") {
  if (!id.startsWith("custom-")) return null;
  const parts = id.split("-");
  if (parts.length < 3) return null;
  return { groupKey: parts[1] };
}

// Build a vertical envelope along time using all member bars/segments
function buildGroupIntervals(members) {
  const stops = new Set();
  for (const m of members) {
    if (Array.isArray(m.segments) && m.segments.length) {
      for (const s of m.segments) {
        stops.add(s.start);
        stops.add(s.end);
      }
    } else {
      stops.add(m.start);
      stops.add(m.end);
    }
  }
  const xs = Array.from(stops).sort((a, b) => a - b);
  if (xs.length < 2) return [];
  const intervals = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const a = xs[i], b = xs[i + 1];
    const mid = (a + b) / 2;
    const active = members.filter((m) => {
      const mStart = m.start, mEnd = m.end;
      return mid >= Math.min(mStart, mEnd) && mid <= Math.max(mStart, mEnd);
    });
    if (!active.length) continue;
    const top = Math.min(...active.map(m => m.y));
    const bottom = Math.max(...active.map(m => m.y + m.h));
    intervals.push({ start: a, end: b, top, bottom });
  }
  return intervals;
}

/* ===== Adaptive tick helpers ===== */
const formatTick = (a) => (Math.abs(a - 0.5) < 1e-6 ? "0" : formatYear(fromAstronomical(a)));

function chooseYearStep(visibleSpanYears) {
  if (visibleSpanYears > 8000) return 1000;
  if (visibleSpanYears > 3000) return 500;
  if (visibleSpanYears > 1200) return 250;
  if (visibleSpanYears > 600)  return 100;
  if (visibleSpanYears > 240)  return 50;
  if (visibleSpanYears > 120)  return 20;
  if (visibleSpanYears > 60)   return 10;
  if (visibleSpanYears > 24)   return 5;
  return 2;
}

function makeAdaptiveTicks(zx) {
  const [aMin0, aMax0] = zx.domain();
  let hMin = fromAstronomical(aMin0);
  let hMax = fromAstronomical(aMax0);
  if (hMin > hMax) [hMin, hMax] = [hMax, hMin];

  const span = Math.max(1, Math.abs(hMax - hMin));
  const step = chooseYearStep(span);

  const start = Math.ceil(hMin / step) * step;
  const ticksHuman = [];
  for (let y = start; y <= hMax; y += step) {
    if (y !== 0) ticksHuman.push(y); // skip 0 (no year zero)
  }

  if (hMin < 0 && hMax > 0) ticksHuman.push(0.5); // BCE/CE marker

  const ticksAstro = ticksHuman.map((y) => (y === 0.5 ? 0.5 : toAstronomical(y)));
  ticksAstro.sort((a, b) => a - b);
  return ticksAstro;
}

// Convert group intervals to a rectilinear (H/V only) envelope path in screen space.
function groupIntervalsToPath(intervals, zx, zy) {
  if (!intervals || intervals.length === 0) return "";

  // Map to screen coords; ensure left<=right; keep chronological order
  const iv = intervals.map((iv) => {
    const xA = zx(toAstronomical(iv.start));
    const xB = zx(toAstronomical(iv.end));
    return {
      xL: Math.min(xA, xB),
      xR: Math.max(xA, xB),
      yT: zy(iv.top),
      yB: zy(iv.bottom),
    };
  });

  // Top chain: left -> right with vertical steps at boundaries
  let d = `M ${iv[0].xL} ${iv[0].yT} H ${iv[0].xR}`;
  for (let i = 1; i < iv.length; i++) {
    if (iv[i - 1].yT !== iv[i].yT) d += ` V ${iv[i].yT}`;  // vertical step at shared x
    d += ` H ${iv[i].xR}`;
  }

  // Right edge down to bottom of last interval
  d += ` V ${iv[iv.length - 1].yB}`;

  // Bottom chain: right -> left with vertical steps at boundaries
  for (let i = iv.length - 1; i >= 0; i--) {
    d += ` H ${iv[i].xL}`;
    if (i > 0 && iv[i - 1].yB !== iv[i].yB) d += ` V ${iv[i - 1].yB}`;
  }

  // Close (back to top-left of first interval)
  d += " Z";
  return d;
}

function shouldShowDurationLabel({ d, k, bandW, bandH, labelSel }) {
  // Always show custom group labels unless explicitly blocked
  if (d._isCustomGroup && !LABEL_BLOCKLIST.has(d.id)) return true;

  if (LABEL_BLOCKLIST.has(d.id)) return false;
  if (LABEL_ALLOWLIST.has(d.id)) return true;

  // Default: hide unless zoomed in enough and there's space
  if (k < ZOOM_TO_FORCE_LABEL) return false;
  if (bandH < MIN_BAND_HEIGHT_FOR_LABEL || bandW < MIN_BAND_WIDTH_FOR_LABEL) return false;

  // Only show if the rendered text actually fits in the band width
  const node = labelSel.node();
  if (node && node.getComputedTextLength) {
    const tw = node.getComputedTextLength();
    return tw + 8 <= bandW; // ~4px padding on each side
  }
  return true; // fallback if measurement not available
}



/* ===== Dynamic dataset discovery (TEXTS ONLY) ===== */
function useDiscoveredDatasets() {
  const textModules =
    import.meta.glob("../data/**/*_texts.json", { eager: true, import: "default" }) || {};
  const folderOf = (p) => {
    const m = p.match(/\/data\/([^/]+)\//);
    return m ? m[1] : null;
  };
  const folders = new Set(Object.keys(textModules).map(folderOf));

  const registry = [];
  folders.forEach((folder) => {
    if (!folder) return;
    const durationId = `${folder}-composite`;
    const texts = Object.entries(textModules)
      .filter(([p]) => folderOf(p) === folder)
      .flatMap(([, data]) => (Array.isArray(data) ? data : []));
    registry.push({ folder, durationId, texts });
  });
  return registry;
}

export default function Timeline() {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);

  const axisRef = useRef(null);
  const gridRef = useRef(null);
  const customPolysRef = useRef(null); // NEW: group polygons layer
  const outlinesRef = useRef(null);
  const segmentsRef = useRef(null);
  const textsRef = useRef(null);
  const prevZoomedInRef = useRef(false);
  const hoveredDurationIdRef = useRef(null);
  const zoomDraggingRef = useRef(false);

  // NEW: single source of truth for hovered segment
  const hoveredSegIdRef = useRef(null);

  // current zoom scale
  const kRef = useRef(1);
  // current rescaled axes for anchoring tooltips
  const zxRef = useRef(null);
  const zyRef = useRef(null);
  // clicked/locked active segment id
  const activeSegIdRef = useRef(null);
  // clicked/locked active duration id (zoomed-out)
  const activeDurationIdRef = useRef(null);
  // brighten label while hovering a segment
  const hoveredSegParentIdRef = useRef(null);
  // One-shot close for duration cards (the next click closes)
  const awaitingCloseClickRef = useRef(false);

  /* ---- Responsive sizing ---- */
  const [size, setSize] = useState({ width: 800, height: 400 });
  const [selectedText, setSelectedText] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [cardPos, setCardPos] = useState({ left: 16, top: 16 });
  const closeAll = () => {
    setSelectedText(null);
    setShowMore(false);
  };
  const modalOpen = !!selectedText;
  const lastTransformRef = useRef(null);  // remembers latest d3.zoom transform
  const didInitRef = useRef(false);       // tracks first-time init

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      setSize({ width: Math.max(320, width), height: Math.max(240, height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const { width, height } = size;

  /* ---- Layout ---- */
  const margin = { top: 8, right: 0, bottom: 28, left: 0 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const axisY = innerHeight;

  /* ---- Time domain & base scales ---- */
  const domainHuman = useMemo(() => [-7000, 2025], []);
  const domainAstro = useMemo(() => domainHuman.map(toAstronomical), [domainHuman]);

  const x = useMemo(
    () => d3.scaleLinear().domain(domainAstro).range([0, innerWidth]),
    [domainAstro, innerWidth]
  );
  const y0 = useMemo(
    () => d3.scaleLinear().domain([0, innerHeight]).range([0, innerHeight]),
    [innerHeight]
  );

  /* ---- Prepare composite OUTLINES (with custom groups) ---- */
  const DEFAULT_BAR_PX = 24;
  const outlines = useMemo(() => {
    // 1) Build raw outlines from durations
    const raw = durations
      .filter(
        (d) =>
          d &&
          (Array.isArray(d.segments) ? d.segments.length > 0 : d.start != null && d.end != null)
      )
      .map((d) => {
        let start, end;
        if (Array.isArray(d.segments) && d.segments.length > 0) {
          start = d3.min(d.segments, (s) => s.start);
          end = d3.max(d.segments, (s) => s.end);
        } else {
          start = d.start;
          end = d.end;
        }
        const y = d.yRel != null ? d.yRel * innerHeight : d.y != null ? d.y : 0;
        const h =
          d.hRel != null ? d.hRel * innerHeight : d.height != null ? d.height : DEFAULT_BAR_PX;

        return {
          id: d.id,
          name: d.name,
          color: d.color || "#999",
          start,
          end,
          y,
          h,
          expandedName: d["expanded name"] || d.name || "",
          broadLifespan: d["broad lifespan"] || "",
          broadNote: d["broad note"] || "",
          segments: Array.isArray(d.segments) ? d.segments.map((s) => ({ ...s })) : [],
          _isCustomMember: !!parseCustomId(d.id),
        };
      });

    // 2) Group custom members by groupKey
    const byGroup = new Map();
    for (const row of raw) {
      const parsed = parseCustomId(row.id);
      if (!parsed) continue;
      const arr = byGroup.get(parsed.groupKey) || [];
      arr.push(row);
      byGroup.set(parsed.groupKey, arr);
    }

    // 3) Build group outlines
    const groupOutlines = [];
    for (const [groupKey, members] of byGroup.entries()) {
      const start = d3.min(members, (m) => m.start);
      const end = d3.max(members, (m) => m.end);
      const top = d3.min(members, (m) => m.y);
      const bot = d3.max(members, (m) => m.y + m.h);
      const y = top;
      const h = bot - top;
      const first = members[0] || {};

      groupOutlines.push({
        id: `customgroup-${groupKey}`,
        name: first.name || `Custom ${groupKey}`,
        expandedName: `${groupKey[0]?.toUpperCase() || ""}${groupKey.slice(1)}`,
        color: first.color || "#999",
        start,
        end,
        y,
        h,
        broadLifespan: first.broadLifespan || "",
        broadNote: first.broadNote || "",
        _isCustomGroup: true,
        _groupKey: groupKey,
        _groupMembers: members.map((m) => ({
          id: m.id, start: m.start, end: m.end, y: m.y, h: m.h, segments: m.segments
        })),
        _groupIntervals: buildGroupIntervals(
          members.map((m) => ({
            id: m.id, start: m.start, end: m.end, y: m.y, h: m.h, segments: m.segments
          }))
        ),
      });
    }

    // 4) Keep non-custom members; drop custom members themselves
    const baseOutlines = raw.filter((r) => !r._isCustomMember);

    // 5) Append group outlines (so groups replace their members at zoomed-out levels)
    return [...baseOutlines, ...groupOutlines];
  }, [durations, innerHeight]);

  /* ---- Segment hover rects ---- */
  const segments = useMemo(() => {
    const rows = [];

    // Map custom member id -> group id (for parent remap)
    const customMemberIdToGroupId = new Map();
    outlines.forEach((o) => {
      if (!o._isCustomGroup) return;
      for (const m of o._groupMembers || []) {
        customMemberIdToGroupId.set(m.id, o.id);
      }
    });

    for (const d of durations) {
      if (!Array.isArray(d.segments)) continue;
      const color = d.color || "#999";
      const y = d.yRel != null ? d.yRel * innerHeight : d.y != null ? d.y : 0;
      const h =
        d.hRel != null ? d.hRel * innerHeight : d.height != null ? d.height : DEFAULT_BAR_PX;

      const parsed = parseCustomId(d.id);
      const parentId = parsed ? (customMemberIdToGroupId.get(d.id) || d.id) : d.id;

      d.segments.forEach((s, i) => {
        rows.push({
          id: `${d.id}__seg_${i}`,
          parentId,
          parentColor: color,
          start: s.start,
          end: s.end,
          y,
          h,
          label: s.label,
          note: s.note,
        });
      });
    }
    return rows;
  }, [durations, innerHeight, outlines]);

  /* ---- Datasets (TEXTS ONLY) ---- */
  const datasetRegistry = useDiscoveredDatasets();

  /* ---- Texts rows ---- */
  const textRows = useMemo(() => {
    const outlinesById = new Map(outlines.map((o) => [o.id, o]));
    const rowsT = [];

    for (const ds of datasetRegistry) {
      const band = outlinesById.get(ds.durationId);
      if (!band) continue;

      const bandY = band.y;
      const bandH = band.h;
      const pad = Math.min(6, Math.max(2, bandH * 0.15));
      const yForKey = (key) => {
        const r = hashString(`${ds.durationId}::${key || "anon"}`);
        return bandY + pad + r * Math.max(1, bandH - 2 * pad);
      };

      for (const t of ds.texts || []) {
        const title = (t["Name"] || "").trim();
        const authorName = (t["Author"] || "").trim();
        const approxDateStr = (t["Approx. Date"] || "").trim();
        const metaphysicalTags = (t["Metaphysical Tags"] || "").trim();
        const artsAndSciencesTags = (t["Arts and Sciences Tags"] || "").trim();
        const accessLevel = (t["Access Level"] || "").trim();
        const shortDescription = (t["Short Description"] || "").trim();
        const jungianArchetypesTags = (t["Jungian Archetypes Tags"] || "").trim();
        const neumannStagesTags = (t["Neumann Stages Tags"] || "").trim();
        const originalGeo = (t["Original Geographical Location"] || "").trim();
        const originalLanguage = (t["Original Language"] || "").trim();
        const comteanFramework = (t["Comtean framework"] || "").trim();
        const category = (t["Category"] || "").trim();
        const socioPoliticalTags = (t["Socio-political Tags"] || "").trim();
        const literaryFormsTags = (t["Literary Forms Tags"] || "").trim();
        const literaryContentTags = (t["Literary Content Tags"] || "").trim();
        const symbolicSystemTags = (t["Symbolic System Tags"] || "").trim();

        const when = getTextDate(t);
        if (!Number.isFinite(when)) continue;

        const color = pickSystemColor(symbolicSystemTags);
        const colors = pickSystemColors(symbolicSystemTags);
        const textKey = `${authorName || "anon"}::${title || ""}::${when}`;
        const y = yForKey(textKey);
        const displayDate = approxDateStr || formatYear(when);

        rowsT.push({
          id: `${ds.durationId}__text__${title || hashString(JSON.stringify(t))}__${when}`,
          durationId: ds.durationId,
          when,
          y,
          color,
          colors,
          title,
          authorName,
          authorKey: isPlaceholderAuthor(authorName) ? null : normalizeAuthor(authorName),
          displayDate,
          metaphysicalTags,
          artsAndSciencesTags,
          accessLevel,
          shortDescription,
          jungianArchetypesTags,
          neumannStagesTags,
          originalGeographicalLocation: originalGeo,
          originalLanguage,
          comteanFramework,
          category,
          socioPoliticalTags,
          literaryFormsTags,
          literaryContentTags,
          symbolicSystemTags,
        });
      }
    }

    // Clamp to band extent
    const bandExtent = new Map(
      outlines.map((o) => [o.id, { min: Math.min(o.start, o.end), max: Math.max(o.start, o.end) }])
    );
    const filtT = rowsT.filter((r) => {
      const e = bandExtent.get(r.durationId);
      return e ? r.when >= e.min && r.when <= e.max : true;
    });

    return filtT;
  }, [datasetRegistry, outlines]);

  // Map: bandId -> Map(authorKey -> laneY_in_band_units_at_k1)
  const authorLaneMap = useMemo(() => {
    const map = new Map();

    // Group texts by band
    const byBand = new Map();
    for (const t of textRows) {
      const arr = byBand.get(t.durationId) || [];
      arr.push(t);
      byBand.set(t.durationId, arr);
    }

    // Fast band lookup
    const bandById = new Map(outlines.map(o => [o.id, o]));

    for (const [bandId, items] of byBand.entries()) {
      const band = bandById.get(bandId);
      if (!band) continue;

      // Band height in "band units" (y0 domain where 1 unit = 1px at k=1)
      const bandTopU = y0(band.y);
      const bandBotU = y0(band.y + band.h);
      const bandHeightU = bandBotU - bandTopU;

      // Unique, non-placeholder authors present in this band (deterministic order)
      const authors = Array.from(
        new Set(items.filter(t => t.authorKey).map(t => t.authorKey))
      ).sort();

      if (authors.length === 0) {            // no real authors in this band
        map.set(bandId, new Map());          // still set an empty map
        continue;
      }

      // Even spacing with padding
      const padU = Math.max(1, bandHeightU * 0.08);
      const usableU = Math.max(1, bandHeightU - 2 * padU);
      const n = Math.max(1, authors.length);
      const stepU = n > 1 ? usableU / (n - 1) : 0;

      const lanes = new Map();
      authors.forEach((ak, i) => {
        const yLaneU = n === 1
          ? bandTopU + bandHeightU / 2
          : bandTopU + padU + i * stepU;
        lanes.set(ak, yLaneU);
      });

      map.set(bandId, lanes);
    }

    return map;
  }, [textRows, outlines, y0]);

  // Close with ESC when a card is open
  useEffect(() => {
    if (!modalOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") closeAll();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [modalOpen]);

  // Hide any tooltips the moment a modal opens
  useEffect(() => {
    if (!modalOpen) return;
    const wrapEl = wrapRef.current;
    if (!wrapEl) return;
    d3.select(wrapEl).selectAll(".tl-tooltip").style("opacity", 0).style("display", "none");
  }, [modalOpen]);

  /* ========= Draw/Update ========= */
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const gRoot = svg.select("g.chart");
    const gAxis = d3.select(axisRef.current);
    const gGrid = d3.select(gridRef.current);
    const gCustom = d3.select(customPolysRef.current); // NEW
    const gOut = d3.select(outlinesRef.current);
    const gSeg = d3.select(segmentsRef.current);
    const gTexts = d3.select(textsRef.current);

    gRoot.attr("transform", `translate(${margin.left},${margin.top})`);

    const axisFor = (scale, ticks) =>
      d3.axisBottom(scale).tickValues(ticks).tickFormat(formatTick);
    const gridFor = (scale, ticks) =>
      d3.axisBottom(scale).tickValues(ticks).tickSize(-innerHeight).tickFormat(() => "");

    // crisp grid lines
    const DPR = window.devicePixelRatio || 1;
    const HALF_DPR_PX = 0.5 / DPR;
    const snapX = (x) => Math.round(x * DPR) / DPR + HALF_DPR_PX;
    function snapGrid(zx) {
      d3.select(gridRef.current)
        .selectAll(".tick")
        .attr("transform", function (d) {
          const x = zx(d);
          const snapped = snapX(x);
          return `translate(${snapped},0)`;
        });
      d3.select(gridRef.current).select(".domain").attr("display", "none");
    }

    // --- INITIAL TRANSFORM (compute BEFORE joins) ---
    const MIN_ZOOM = 0.9;
    const MAX_ZOOM = 22;
    const s = MIN_ZOOM;
    {
      const tx = (innerWidth - innerWidth * s) / 2;
      const ty = (innerHeight - innerHeight * s) / 2;
      const t0 = d3.zoomIdentity.translate(tx, ty).scale(s);
      const tInit = lastTransformRef.current ?? t0;
      kRef.current = tInit.k;
    }

    // ----- Three tooltip DIVs (no author tip now) -----
    const wrapEl = wrapRef.current;
    function makeTip(className) {
      return d3
        .select(wrapEl)
        .selectAll(`div.${className}`)
        .data([0])
        .join("div")
        .attr("class", `tl-tooltip ${className}`)
        .style("position", "absolute")
        .style("pointer-events", "none")
        .style("opacity", 0)
        .style("display", "none")
        .style("transform", "translate3d(0,0,0)");
    }
    const tipText = makeTip("tl-text");
    const tipSeg = makeTip("tl-seg");
    const tipDur = makeTip("tl-duration");

    const hideTipSel = (sel) => sel.style("opacity", 0).style("display", "none");

    function showTip(sel, html, clientX, clientY, accent) {
      const wrapRect = wrapEl.getBoundingClientRect();
      sel
        .html(html)
        .style("display", "block")
        .style("opacity", 1)
        .style("--accent", accent || "");

      const node = sel.node();
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      const pad = 6;

      // center above cursor if possible; otherwise below
      let x = clientX - wrapRect.left - tw / 2;
      let y = clientY - wrapRect.top - th - pad;
      let below = false;
      if (y < 0) {
        y = clientY - wrapRect.top + pad;
        below = true;
      }

      // clamp horizontally
      const maxX = wrapRect.width - tw - 4;
      x = Math.max(4, Math.min(x, maxX));

      sel.style("left", `${x}px`).style("top", `${y}px`).classed("below", below);
    }

    // ===== SEGMENT ANCHORING helpers =====
    function getSegmentAnchorPx(seg) {
      const zx = zxRef.current;
      const zy = zyRef.current;
      if (!zx || !zy) return null;

      const x0 = zx(toAstronomical(seg.start));
      const x1 = zx(toAstronomical(seg.end));
      const yTop = zy(seg.y);
      const hPix = zy(seg.y + seg.h) - zy(seg.y);

      const left = Math.min(x0, x1);
      const right = Math.max(x0, x1);
      const xMid = (left + right) / 2;

      return { left, right, xMid, yTop, hPix };
    }

    function showSegAnchored(seg) {
      const anchor = getSegmentAnchorPx(seg);
      if (!anchor) return;

      const wrapRect = wrapEl.getBoundingClientRect();

      tipSeg
        .html(tipHTML(seg.label || "", fmtRange(seg.start, seg.end), seg.note || ""))
        .style("display", "block")
        .style("opacity", 1)
        .style("--accent", seg.parentColor || "");

      const node = tipSeg.node();
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      const pad = 8;

      // Prefer below the segment; flip above if it would overflow
      let x = anchor.xMid - tw / 2;
      let y = anchor.yTop + anchor.hPix + pad;
      let below = true;

      if (y + th > wrapRect.height) {
        y = anchor.yTop - th - pad;
        below = false;
      }

      const maxX = wrapRect.width - tw - 4;
      x = Math.max(4, Math.min(x, maxX));

      tipSeg.style("left", `${x}px`).style("top", `${y}px`).classed("below", below);
    }

    // ===== DURATION ANCHORING helpers =====
    function getDurationAnchorPx(outline) {
      const zx = zxRef.current;
      const zy = zyRef.current;
      if (!zx || !zy) return null;

      const x0 = zx(toAstronomical(outline.start));
      const x1 = zx(toAstronomical(outline.end));
      const yTop = zy(outline.y);
      const hPix = zy(outline.y + outline.h) - zy(outline.y);

      const left = Math.min(x0, x1);
      const right = Math.max(x0, x1);
      const xMid = (left + right) / 2;

      return { left, right, xMid, yTop, hPix };
    }

    function showDurationAnchored(outline) {
      const anchor = getDurationAnchorPx(outline);
      if (!anchor) return;

      const wrapRect = wrapEl.getBoundingClientRect();

      tipDur
        .html(
          tipHTML(
            outline.expandedName || outline.name || "",
            outline.broadLifespan || fmtRange(outline.start, outline.end),
            outline.broadNote || ""
          )
        )
        .style("display", "block")
        .style("opacity", 1)
        .style("--accent", outline.color || "");

      const node = tipDur.node();
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      const pad = 8;

      // Prefer below the band; flip above if needed
      let x = anchor.xMid - tw / 2;
      let y = anchor.yTop + anchor.hPix + pad;
      let below = true;

      if (y + th > wrapRect.height) {
        y = anchor.yTop - th - pad;
        below = false;
      }

      const maxX = wrapRect.width - tw - 4;
      x = Math.max(4, Math.min(x, maxX));

      tipDur.style("left", `${x}px`).style("top", `${y}px`).classed("below", below);
    }

    // ===== Label + border visuals (3 states) =====
    function updateHoverVisuals() {
      const activeDurationId = activeDurationIdRef.current;
      const hoveredDurationId = hoveredDurationIdRef.current;

      const activeSegId = activeSegIdRef.current;
      const seg = activeSegId ? segments.find((s) => s.id === activeSegId) : null;
      const activeParentFromSeg = seg ? seg.parentId : null;

      const hoveredSegParentId = hoveredSegParentIdRef.current;

      const ignoreHoverBecauseActive = !!activeDurationId;

      // Borders (outlineRect)
      // Borders (outlineRect) — never draw stroke for custom groups
d3.select(outlinesRef.current)
  .selectAll("rect.outlineRect")
  .attr("stroke-opacity", (d) => {
    const isGroup = !!d._isCustomGroup;
    if (isGroup) return 0; // <- keep group rect invisible, even on hover/active
    const isActive = d.id === activeDurationId;
    const isHover  = !ignoreHoverBecauseActive && d.id === hoveredDurationId;
    if (isActive) return DUR_STROKE.activeOpacity;
    if (isHover)  return DUR_STROKE.hoverOpacity;
    return DUR_STROKE.baseOpacity;
  })
  .attr("stroke-width", (d) => {
    const isGroup = !!d._isCustomGroup;
    if (isGroup) return DUR_STROKE.baseWidth; // value irrelevant since opacity is 0
    const isActive = d.id === activeDurationId;
    const isHover  = !ignoreHoverBecauseActive && d.id === hoveredDurationId;
    if (isActive) return DUR_STROKE.activeWidth;
    if (isHover)  return DUR_STROKE.hoverWidth;
    return DUR_STROKE.baseWidth;
  });


      // Labels (durationLabel)
      d3.select(outlinesRef.current)
        .selectAll("text.durationLabel")
        .attr("opacity", (d) => {
          if (d.id === activeDurationId || d.id === activeParentFromSeg) return DUR_LABEL_OPACITY.active;
          if (!ignoreHoverBecauseActive &&
              (d.id === hoveredDurationId || d.id === hoveredSegParentId)) {
            return DUR_LABEL_OPACITY.hover;
          }
          return DUR_LABEL_OPACITY.base;
        });

        // Also style custom group polygons (borders) the same way
      d3.select(customPolysRef.current)
        .selectAll("path.customGroup")
        .attr("stroke-opacity", (d) => {
          if (d.id === activeDurationId) return DUR_STROKE.activeOpacity;
          if (!ignoreHoverBecauseActive && d.id === hoveredDurationId) return DUR_STROKE.hoverOpacity;
            return 0.22; // base opacity for polygons
        })
        .attr("stroke-width", (d) => {
          if (d.id === activeDurationId) return DUR_STROKE.activeWidth;
          if (!ignoreHoverBecauseActive && d.id === hoveredDurationId) return DUR_STROKE.hoverWidth;
        return 1.5; // base width for polygons
        });

      }

    // NEW: centralized segment preview updater
    function updateSegmentPreview() {
      const activeId = activeSegIdRef.current;
      const hoveredId = hoveredSegIdRef.current;

      d3.select(segmentsRef.current)
        .selectAll("rect.segmentHit")
        .attr("stroke-opacity", (d) => (d.id === activeId ? 1 : d.id === hoveredId ? 0.5 : 0.02))
        .attr("stroke-width", (d) => (d.id === activeId ? 2 : d.id === hoveredId ? 2 : 1.5));
    }

    function clearActiveSegment() {
      activeSegIdRef.current = null;
      hoveredSegIdRef.current = null;          // clear preview too
      hoveredSegParentIdRef.current = null;
      updateSegmentPreview();
      hideTipSel(tipSeg);
      updateHoverVisuals();
    }

    function clearActiveDuration() {
      activeDurationIdRef.current = null;
      awaitingCloseClickRef.current = false;
      hideTipSel(tipDur);
      updateHoverVisuals();
    }

    // Only set active + (optionally) show card on demand (segment)
    function setActiveSegment(seg, { showCard = false } = {}) {
      if (!seg) return clearActiveSegment();
      activeSegIdRef.current = seg.id;
      hoveredSegIdRef.current = null;          // active replaces preview
      hoveredSegParentIdRef.current = seg.parentId;
      updateSegmentPreview();
      if (showCard) showSegAnchored(seg);
      else hideTipSel(tipSeg);
      updateHoverVisuals();
    }

    function setActiveDuration(outline, { showCard = false } = {}) {
      if (!outline) return clearActiveDuration();
      activeDurationIdRef.current = outline.id;
      if (showCard) showDurationAnchored(outline);
      updateHoverVisuals();
    }

    // Sync hovered duration from pointer while zooming (zoomed-out mode)
  function syncDurationHoverFromPointer(se) {
  // Only track duration hover while zoomed OUT
  if (!se || !("clientX" in se) || kRef.current >= ZOOM_THRESHOLD) return;

  const el = document.elementFromPoint(se.clientX, se.clientY);
  let newId = null;

  if (el && el.classList) {
    if (el.classList.contains("outlineRect")) {
      // Rect lives inside a <g.durationOutline> that holds the datum
      const d = d3.select(el.parentNode).datum();
      newId = d?.id ?? null;
    } else if (el.classList.contains("customGroup")) {
      // Polygon path has the datum directly bound
      const d = d3.select(el).datum();
      newId = d?.id ?? null;
    }
  }

  if (hoveredDurationIdRef.current !== newId) {
    hoveredDurationIdRef.current = newId;
    updateHoverVisuals();
  }
}


    // NEW: Sync hovered segment from pointer while zooming (zoomed-in mode)
    function syncSegmentHoverFromPointer(se) {
      if (!se || !("clientX" in se) || kRef.current < ZOOM_THRESHOLD) return;
      const el = document.elementFromPoint(se.clientX, se.clientY);
      let newId = null, newParentId = null;

      if (el && el.classList && el.classList.contains("segmentHit")) {
        const d = d3.select(el).datum();
        newId = d?.id ?? null;
        newParentId = d?.parentId ?? null;
      }

      if (hoveredSegIdRef.current !== newId) {
        hoveredSegIdRef.current = newId;
        hoveredSegParentIdRef.current = newParentId;
        updateSegmentPreview();
        updateHoverVisuals();
      }
    }

    // OUTLINES (filled, faint stroke)
    const outlineSel = gOut
      .selectAll("g.durationOutline")
      .data(outlines, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "durationOutline").attr("data-id", (d) => d.id);

        g.append("rect")
          .attr("class", "outlineRect")
          .attr("fill", (d) => d.color)
          .attr("fill-opacity", 0.1)
          .attr("stroke", (d) => d.color)
          .attr("stroke-opacity", DUR_STROKE.baseOpacity)
          .attr("stroke-width", DUR_STROKE.baseWidth)
          .attr("vector-effect", "non-scaling-stroke")
          .attr("shape-rendering", "geometricPrecision");

        g.append("text")
          .attr("class", "durationLabel")
          .attr("dy", "0.32em")
          .style("dominant-baseline", "middle")
          .attr("fill", (d) => d.color)
          .attr("opacity", DUR_LABEL_OPACITY.base)
          .style("font-weight", 600)
          .style("pointer-events", "none")
          .text((d) => d.name);

        return g;
      });

    // Hide the rectangle if this is a custom GROUP (polygon handles visuals)
    outlineSel.select("rect.outlineRect")
      .attr("fill-opacity", (d) => d._isCustomGroup ? 0 : 0.1)
      .attr("stroke-opacity", (d) => d._isCustomGroup ? 0 : DUR_STROKE.baseOpacity)
      .style("pointer-events", (d) => d._isCustomGroup ? "none" : "all");

    // Whole-duration hover/click (zoomed-out only)
    outlineSel.select("rect.outlineRect")
      .on("mouseenter", function (_ev, d) {
        if (kRef.current >= ZOOM_THRESHOLD) return;
        if (activeDurationIdRef.current) return; // ignore hover while a duration is active
        hoveredDurationIdRef.current = d.id;
        updateHoverVisuals();
      })
      .on("mouseleave", function () {
        if (kRef.current >= ZOOM_THRESHOLD) return;
        if (zoomDraggingRef.current) return;
        if (activeDurationIdRef.current) return; // keep active styles
        hoveredDurationIdRef.current = null;
        updateHoverVisuals();
      })
      .on("click", function (ev, d) {
        if (kRef.current >= ZOOM_THRESHOLD) return;

        if (awaitingCloseClickRef.current) {
          awaitingCloseClickRef.current = false;
          clearActiveDuration();
          ev.stopPropagation();
          return;
        }

        clearActiveSegment();
        setActiveDuration(d, { showCard: true });
        awaitingCloseClickRef.current = true;
        ev.stopPropagation();
      });

    // CUSTOM GROUP POLYGONS (drawn under labels)
    gCustom
      .selectAll("path.customGroup")
      .data(outlines.filter((o) => o._isCustomGroup), (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("path")
            .attr("class", "customGroup")
            .attr("fill", (d) => d.color)
            .attr("fill-opacity", 0.08)
            .attr("stroke", (d) => d.color)
            .attr("stroke-opacity", 0.22)
            .attr("stroke-width", 1.5)
            .attr("vector-effect", "non-scaling-stroke")
            .attr("shape-rendering", "geometricPrecision"),
        (update) => update,
        (exit) => exit.remove()
      );

      // Hover/click on the polygon itself (zoomed-out only)
gCustom.selectAll("path.customGroup")
  .style("pointer-events", "all")
  .on("mouseenter", function (_ev, d) {
    if (kRef.current >= ZOOM_THRESHOLD) return;
    if (activeDurationIdRef.current) return;
    hoveredDurationIdRef.current = d.id;
    updateHoverVisuals();
  })
  .on("mouseleave", function () {
    if (kRef.current >= ZOOM_THRESHOLD) return;
    if (zoomDraggingRef.current) return;
    if (activeDurationIdRef.current) return;
    hoveredDurationIdRef.current = null;
    updateHoverVisuals();
  })
  .on("click", function (ev, d) {
    if (kRef.current >= ZOOM_THRESHOLD) return;

    if (awaitingCloseClickRef.current) {
      awaitingCloseClickRef.current = false;
      clearActiveDuration();
      ev.stopPropagation();
      return;
    }

    clearActiveSegment();
    setActiveDuration(d, { showCard: true });
    awaitingCloseClickRef.current = true;
    ev.stopPropagation();
  });


    // TEXTS (dots)
    const textSel = gTexts
      .selectAll("circle.textDot")
      .data(textRows, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("circle")
            .attr("class", "textDot")
            .attr("fill", (d) => (d.colors && d.colors.length > 1 ? "none" : (d.color || "#444")))
            .attr("opacity", BASE_OPACITY)
            .attr("r", TEXT_BASE_R * kRef.current)
            .style("transition", "r 120ms ease"),
        (update) =>
          update.attr(
            "fill",
            (d) => (d.colors && d.colors.length > 1 ? "none" : (d.color || "#444"))
          ),
        (exit) => exit.remove()
      );

    // Keep draw order stable to reduce flicker
    gTexts.selectAll("circle.textDot")
      .sort((a, b) => (a.when - b.when) || a.durationId.localeCompare(b.durationId));

    // --- PIE SLICES FOR MULTI-COLOR DOTS ---
    function slicesDataFor(d) {
      return (d.colors || []).map((color, i) => ({ color, i, n: d.colors.length, id: d.id }));
    }

    // one group per multi-color text
    gTexts
      .selectAll("g.dotSlices")
      .data(textRows.filter((d) => (d.colors || []).length > 1), (d) => d.id)
      .join(
        (enter) => {
          const g = enter
            .append("g")
            .attr("class", "dotSlices")
            .attr("data-id", (d) => d.id)
            .style("pointer-events", "none")
            .style("opacity", BASE_OPACITY);

          g.selectAll("path.slice")
            .data((d) => slicesDataFor(d))
            .join("path")
            .attr("class", "slice")
            .attr("fill", (s) => s.color);

          return g;
        },
        (update) => {
          update
            .selectAll("path.slice")
            .data((d) => slicesDataFor(d))
            .join(
              (e2) => e2.append("path").attr("class", "slice").attr("fill", (s) => s.color),
              (u2) => u2.attr("fill", (s) => s.color),
              (x2) => x2.remove()
            );
          return update;
        },
        (exit) => exit.remove()
      );

    // Keep draw order stable for pies as well
    gTexts.selectAll("g.dotSlices")
      .sort((a, b) => (a.when - b.when) || a.durationId.localeCompare(b.durationId));

    // helper to (re)compute wedge paths at a given radius
    function drawSlicesAtRadius(selection, r) {
      const arcGen = d3.arc().innerRadius(0).outerRadius(r);

      selection.each(function (d) {
        const g = d3.select(this);
        const n = (d.colors || []).length;

        g.selectAll("path.slice").attr("d", (s) => {
          if (n === 2) {
            // First color on the RIGHT, second on the LEFT
            const halves = [
              { startAngle: 0, endAngle: Math.PI },               // right half
              { startAngle: Math.PI, endAngle: 2 * Math.PI },     // left half
            ];
            const h = halves[Math.min(s.i, 1)];
            return arcGen(h);
          }
          // Default fan layout (starts at top, clockwise)
          const a0 = (s.i / n) * 2 * Math.PI - Math.PI / 2;
          const a1 = ((s.i + 1) / n) * 2 * Math.PI - Math.PI / 2;
          return arcGen({ startAngle: a0, endAngle: a1 });
        });
      });
    }

    const within = (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b);

    const findSegForText = (d) =>
      segments.find(
        (s) =>
          s.parentId === d.durationId &&
          d.when >= s.start &&
          d.when <= s.end &&
          within(d.y, s.y, s.y + s.h)
      );

    // Text dots hover/click (zoomed-in only via pointer-events toggle)
    textSel
      .on("mouseenter", function (_ev, d) {
        const k = kRef.current;
        const newR = TEXT_BASE_R * k * HOVER_SCALE_DOT;

        d3.select(this).attr("r", newR).attr("opacity", 1);

        // Sync the pie slices (if any) to the same radius and opacity
        const gPie = gTexts.select(`g.dotSlices[data-id='${d.id}']`);
        if (!gPie.empty()) {
          gPie.style("opacity", 1);
          drawSlicesAtRadius(gPie, newR);
        }

        // NEW: derive segment preview from state (no ad-hoc styling)
        const seg = findSegForText(d);
        if (seg) {
          hoveredSegIdRef.current = seg.id;
          hoveredSegParentIdRef.current = seg.parentId;
          updateSegmentPreview();
          updateHoverVisuals();
        }

        const html = tipHTML(d.title || "", d.displayDate || formatYear(d.when));
        const a = textAnchorClient(this, d);
        if (a) showTip(tipText, html, a.x, a.y, d.color);
      })
      .on("mousemove", function (_ev, d) {
        const html = tipHTML(d.title || "", d.displayDate || formatYear(d.when));
        const a = textAnchorClient(this, d);
        if (a) showTip(tipText, html, a.x, a.y, d.color);
      })
      .on("mouseleave", function (_ev, d) {
        const k = kRef.current;
        const rDraw = TEXT_BASE_R * k;

        d3.select(this).attr("r", rDraw).attr("opacity", BASE_OPACITY);
        hideTipSel(tipText);

        // Shrink/restore pie radius + opacity to match circle
        const gPie = gTexts.select(`g.dotSlices[data-id='${d.id}']`);
        if (!gPie.empty()) {
          gPie.style("opacity", BASE_OPACITY);
          drawSlicesAtRadius(gPie, rDraw);
        }

        // clear preview if it came from this text
        const seg = findSegForText(d);
        if (seg && hoveredSegIdRef.current === seg.id) {
          hoveredSegIdRef.current = null;
          hoveredSegParentIdRef.current = null;
          updateSegmentPreview();
          updateHoverVisuals();
        }
      })
      .on("click", function (ev, d) {
        clearActiveSegment();

        const a = textAnchorClient(this, d);
        const wrapRect = wrapRef.current.getBoundingClientRect();

        const CARD_W = 360;
        const CARD_H = 320;
        const PAD = 12;

        let left = a ? a.x - wrapRect.left + PAD : PAD;
        let top = a ? a.y - wrapRect.top + PAD : PAD;

        left = Math.max(4, Math.min(left, wrapRect.width - CARD_W - 4));
        top = Math.max(4, Math.min(top, wrapRect.height - CARD_H - 4));

        hideTipSel(tipText);
        hideTipSel(tipSeg);
        hideTipSel(tipDur);

        setCardPos({ left, top });
        setSelectedText(d);
        setShowMore(false);

        ev.stopPropagation();
      })
      .attr("opacity", BASE_OPACITY);

    function textAnchorClient(el, d) {
      const zx = zxRef.current,
        zy = zyRef.current;
      if (!zx || !zy) return null;
      const svgRect = svgRef.current.getBoundingClientRect();

      const cx = zx(toAstronomical(d.when));
      // Fallback must use band-units -> current zoom
      const cyAttr = el ? parseFloat(d3.select(el).attr("cy")) : zy(y0(d.y));

      return {
        x: svgRect.left + margin.left + cx,
        y: svgRect.top + margin.top + cyAttr,
      };
    }

    function apply(zx, zy, k = 1) {
      // cache latest rescaled axes for anchored tooltips
      zxRef.current = zx;
      zyRef.current = zy;

      // axis & grid with adaptive ticks
      const ticks = makeAdaptiveTicks(zx);
      gAxis.attr("transform", `translate(${margin.left},${margin.top + axisY})`).call(axisFor(zx, ticks));
      gGrid.attr("transform", `translate(0,${axisY})`).call(gridFor(zx, ticks));
      snapGrid(zx);

      // outlines rects
      gOut.selectAll("rect.outlineRect").each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        d3.select(this).attr("x", Math.min(x0, x1)).attr("y", yTop).attr("width", Math.abs(x1 - x0)).attr("height", hPix);
      });

      // labels (font scales with the band's rendered height)
// labels (font scales with the band's rendered height)
gOut.selectAll("g.durationOutline").each(function (d) {
  const g = d3.select(this);
  const x0 = zx(toAstronomical(d.start));
  const x1 = zx(toAstronomical(d.end));
  const yTop = zy(d.y);
  const hPix = zy(d.y + d.h) - zy(d.y);

  const maxByBand = hPix * LABEL_FONT_MAX_REL;
  const fontPx = clamp(
    hPix * LABEL_TO_BAND,
    LABEL_FONT_MIN,
    Math.min(LABEL_FONT_MAX_ABS, maxByBand)
  );

  const labelSel = g.select("text.durationLabel")
    .attr("x", Math.min(x0, x1) + 4)
    .attr("y", yTop + hPix / 3)
    .style("font-size", `${fontPx}px`);

  // NEW: decide visibility after sizing
  const bandW = Math.abs(x1 - x0);
  const show = shouldShowDurationLabel({
    d,
    k,
    bandW,
    bandH: hPix,
    labelSel
  });

  labelSel.style("display", show ? null : "none");
});


      // segment hit rects
      gSeg.selectAll("rect.segmentHit").each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        d3.select(this).attr("x", Math.min(x0, x1)).attr("y", yTop).attr("width", Math.abs(x1 - x0)).attr("height", hPix);
      });

      // Draw/update custom group polygons
      // Draw/update custom group polygons (rectilinear envelope, no diagonals)
gCustom.selectAll("path.customGroup").each(function (o) {
  const intervals = o._groupIntervals || [];
  if (!intervals.length) {
    // Fallback: simple rectangle
    const x0 = zx(toAstronomical(o.start));
    const x1 = zx(toAstronomical(o.end));
    const yTop = zy(o.y);
    const hPix = zy(o.y + o.h) - zy(o.y);
    const d = `M ${Math.min(x0, x1)} ${yTop} H ${Math.max(x0, x1)} V ${yTop + hPix} H ${Math.min(x0, x1)} Z`;
    d3.select(this).attr("d", d);
    return;
  }
  d3.select(this).attr("d", groupIntervalsToPath(intervals, zx, zy));
});


      // === Author-lane layout (stable across zoom) ===
      const rDraw = TEXT_BASE_R * k;

      // Position circles using per-band author lanes
      gTexts.selectAll("circle.textDot").each(function (d) {
        const cx = zx(toAstronomical(d.when));

        // Default to the original hashed Y (what you had before lanes)
        let cyU = y0(d.y);

        if (d.authorKey) { // only lane-align if real author
          const lanes = authorLaneMap.get(d.durationId);
          const laneU = lanes?.get(d.authorKey);
          if (Number.isFinite(laneU)) cyU = laneU;
        }

        const cy = zy(cyU);
        d3.select(this).attr("cx", cx).attr("cy", cy).attr("r", TEXT_BASE_R * k);
      });

      // Position pies to match circles (same cy rule)
      gTexts.selectAll("g.dotSlices").each(function (d) {
        const cx = zx(toAstronomical(d.when));

        let cyU = y0(d.y);
        if (d.authorKey) {
          const lanes = authorLaneMap.get(d.durationId);
          const laneU = lanes?.get(d.authorKey);
          if (Number.isFinite(laneU)) cyU = laneU;
        }

        const cy = zy(cyU);
        const g = d3.select(this);
        g.attr("transform", `translate(${cx},${cy})`);
        drawSlicesAtRadius(g, TEXT_BASE_R * k);
      });
    }

    function updateInteractivity(k) {
      const zoomedIn = k >= ZOOM_THRESHOLD;

      gOut.selectAll("rect.outlineRect").style("pointer-events", zoomedIn ? "none" : "all");
      gSeg.selectAll("rect.segmentHit").style("pointer-events", zoomedIn ? "all" : "none");
      gTexts.selectAll("circle.textDot").style("pointer-events", zoomedIn ? "all" : "none");
      gCustom.selectAll("path.customGroup").style("pointer-events", zoomedIn ? "none" : "all");


      if (!zoomedIn) {
        clearActiveSegment();
      } else {
        clearActiveDuration();
      }
      updateHoverVisuals();
    }

    // Build segmentHit rects (with CLICK-to-open behavior)
    gSeg
      .selectAll("rect.segmentHit")
      .data(segments, (d) => d.id)
      .join((enter) =>
        enter
          .append("rect")
          .attr("class", "segmentHit")
          .attr("fill", "transparent")
          .attr("pointer-events", "all")
          .attr("stroke", (d) => d.parentColor)
          .attr("stroke-opacity", 0.02)
          .attr("stroke-width", 1.5)
          .attr("vector-effect", "non-scaling-stroke")
          .attr("shape-rendering", "geometricPrecision")
          .style("transition", "stroke-opacity 140ms ease, stroke-width 140ms ease")
          // HOVER: centralized preview + label brightening
          .on("mouseenter", function (_ev, seg) {
            if (activeSegIdRef.current === seg.id) return;
            hoveredSegIdRef.current = seg.id;
            hoveredSegParentIdRef.current = seg.parentId;
            updateSegmentPreview();
            updateHoverVisuals();
          })
          .on("mouseleave", function (_ev, seg) {
            if (activeSegIdRef.current === seg.id) return;
            hoveredSegIdRef.current = null;
            hoveredSegParentIdRef.current = null;
            updateSegmentPreview();
            updateHoverVisuals();
          })
          // CLICK: toggle the segment card
          .on("click", function (_ev, seg) {
            const isSame = activeSegIdRef.current === seg.id;
            if (isSame) {
              clearActiveSegment();
              return;
            }
            clearActiveSegment();
            clearActiveDuration(); // don't mix duration+segment cards
            setActiveSegment(seg, { showCard: true });
          })
      );

    // set up zoom
    const zoom = d3.zoom()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .translateExtent([[0,0],[innerWidth, innerHeight]])
      .extent([[0,0],[innerWidth, innerHeight]])
      .filter((event) => event.type !== "dblclick")
      .on("start", () => {
        zoomDraggingRef.current = true;
        // NEW: hard reset any stale segment preview at the start of a gesture
        hoveredSegIdRef.current = null;
        hoveredSegParentIdRef.current = null;
        updateSegmentPreview();
        updateHoverVisuals();
      })
      .on("zoom", (event) => {
        const t = event.transform;
        lastTransformRef.current = t;
        kRef.current = t.k;

        const zx = t.rescaleX(x);
        const zy = t.rescaleY(y0);
        apply(zx, zy, t.k);
        updateInteractivity(t.k);

        // Keep duration hover correct while zooming (only in zoomed-out mode)
        syncDurationHoverFromPointer(event.sourceEvent);
        // NEW: keep segment hover in sync when zoomed-in
        syncSegmentHoverFromPointer(event.sourceEvent);

        // If a segment is active, keep its card anchored as we zoom/pan
        if (activeSegIdRef.current) {
          const seg = segments.find((s) => s.id === activeSegIdRef.current);
          if (seg) showSegAnchored(seg);
        }
        // If a duration is active, keep its card anchored as we zoom/pan
        if (activeDurationIdRef.current) {
          const out = outlines.find((o) => o.id === activeDurationIdRef.current);
          if (out) showDurationAnchored(out);
        }

        // Threshold handoff logic
        const zoomedIn = t.k >= ZOOM_THRESHOLD;
        const wasZoomedIn = prevZoomedInRef.current;

        if (zoomedIn && !wasZoomedIn) {
          hoveredDurationIdRef.current = null;
          awaitingCloseClickRef.current = false; // reset one-shot close
          clearActiveDuration();                  // hide duration card when zooming in
          updateHoverVisuals();
        }

        if (!zoomedIn && wasZoomedIn) {
          clearActiveSegment();
          updateHoverVisuals();
        }

        prevZoomedInRef.current = zoomedIn;
      })
      .on("end", (event) => {
        zoomDraggingRef.current = false;
        // Final re-sync after the zoom settles
        syncDurationHoverFromPointer(event.sourceEvent);
        syncSegmentHoverFromPointer(event.sourceEvent);
        updateHoverVisuals();
      });

    const svgSel = d3.select(svgRef.current);

    // FIRST DRAW using the chosen transform (persisted if available)
    const initT = lastTransformRef.current ?? d3.zoomIdentity
      .translate((innerWidth - innerWidth * (0.9)) / 2, (innerHeight - innerHeight * (0.9)) / 2)
      .scale(0.9);

    apply(initT.rescaleX(x), initT.rescaleY(y0), initT.k);
    svgSel.call(zoom).call(zoom.transform, initT);
    updateInteractivity(initT.k);

    // Click-away to close cards / one-shot close for durations
svgSel.on("click.clearActive", (ev) => {
  // One-shot close for an open duration card
  if (awaitingCloseClickRef.current) {
    awaitingCloseClickRef.current = false;
    clearActiveDuration();
    return;
  }

  const el = ev.target;
  const cl = el && el.classList;

  const isSeg       = cl && cl.contains("segmentHit");
  const isOutline   = cl && cl.contains("outlineRect");
  const isGroupPoly = cl && cl.contains("customGroup");

  // Only clear if the click was NOT on a segment, NOT on a duration rect,
  // and NOT on a custom group polygon.
  if (!isSeg && !isOutline && !isGroupPoly) {
    clearActiveSegment();
    clearActiveDuration();
  }
});


    // Mark that we've initialized at least once
    didInitRef.current = true;

    // Hide tooltips if mouse leaves the whole svg area
    svgSel.on("mouseleave.tl-tip", () => {
      hideTipSel(tipText);
      // do not clear active segment/duration on leave; cards stay until click-away/zoom-in
    });

    return () => {
      d3.select(svgRef.current).on(".zoom", null);
      svgSel.on("mouseleave.tl-tip", null);
      svgSel.on("click.clearActive", null);
    };
  }, [
    outlines,
    segments,
    textRows,
    width,
    height,
    innerWidth,
    innerHeight,
    axisY,
    margin.left,
    margin.top,
    x,
    y0,
  ]);

  return (
    <div
      ref={wrapRef}
      className="timelineWrap"
      style={{ width: "100%", height: "100%", position: "relative" }}
    >
      <svg
        ref={svgRef}
        className={`timelineSvg ${modalOpen ? "isModalOpen" : ""}`}
        width={width}
        height={height}
      >
        <g className="chart" transform={`translate(${margin.left},${margin.top})`}>
          <g ref={gridRef} className="grid" />
          <g ref={customPolysRef} className="customPolys" /> {/* NEW: polygon layer under labels */}
          <g ref={outlinesRef} className="durations" />
          <g ref={segmentsRef} className="segments" />
          <g ref={textsRef} className="texts" />
        </g>
        <g ref={axisRef} className="axis" />
      </svg>

      {/* Backdrop for modal; closes on click */}
      {modalOpen && <div className="modalBackdrop" onClick={closeAll} />}

      {/* Text modal */}
      {selectedText && (
        <TextCard
          d={selectedText}
          left={cardPos.left}
          top={cardPos.top}
          showMore={showMore}
          setShowMore={setShowMore}
          onClose={closeAll}
        />
      )}
    </div>
  );
}
