import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import durations from "../data/durations.json";
import "../styles/timeline.css";
import TextCard from "./textCard";
import AuthorCard from "./authorCard";

/* ===== BCE/CE helpers (no year 0) ===== */
const toAstronomical = (y) => (y <= 0 ? y + 1 : y);
const fromAstronomical = (a) => (a <= 0 ? a - 1 : a);
const formatYear = (y) => (y < 0 ? `${Math.abs(y)} BCE` : y > 0 ? `${y} CE` : "—");

/* ===== Colors for Symbolic Systems ===== */
const SymbolicSystemColorPairs = {
  Sumerian: "#1D4ED8",
  Akkadian: "#7C4DFF",
  Egyptian: "#FF3B30",
  "Ancient Egyptian": "#FF3B30",
};

/* ===== Label sizing vs zoom ===== */
const LABEL_BASE_PX = 11;

/* ===== Render + hover constants ===== */
const BASE_OPACITY = 0.3;
const AUTHOR_BASE_STROKE = 1;  // at k=1
const TEXT_BASE_R = 0.7;       // at k=1
const HOVER_SCALE_DOT = 1.6;   // how much bigger a dot gets on hover
const HOVER_SCALE_LINE = 1.6;  // how much thicker a line gets on hover
const ZOOM_THRESHOLD = 2.4;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* --- Opacity/width levels for duration label + border --- */
const DUR_LABEL_OPACITY = { base: 0.3, hover: 0.75, active: 1 };
const DUR_STROKE = {
  baseOpacity: 0.08, hoverOpacity: 0.45, activeOpacity: 0.9,
  baseWidth: 1.5,    hoverWidth: 2.0,    activeWidth: 2.5,
};

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
function pickSystemColor(tagsStr) {
  if (!tagsStr) return "#444";
  const parts = String(tagsStr).split(",").map((s) => s.trim());
  for (const p of parts) if (SymbolicSystemColorPairs[p]) return SymbolicSystemColorPairs[p];
  return "#444";
}

/* ===== Dynamic dataset discovery ===== */
function useDiscoveredDatasets() {
  const authorModules =
    import.meta.glob("../data/**/*_authors.json", { eager: true, import: "default" }) || {};
  const textModules =
    import.meta.glob("../data/**/*_texts.json", { eager: true, import: "default" }) || {};
  const folderOf = (p) => {
    const m = p.match(/\/data\/([^/]+)\//);
    return m ? m[1] : null;
  };
  const folders = new Set([
    ...Object.keys(authorModules).map(folderOf),
    ...Object.keys(textModules).map(folderOf),
  ]);

  const registry = [];
  folders.forEach((folder) => {
    if (!folder) return;
    const durationId = `${folder}-composite`;
    const authors = Object.entries(authorModules)
      .filter(([p]) => folderOf(p) === folder)
      .flatMap(([, data]) => (Array.isArray(data) ? data : []));
    const texts = Object.entries(textModules)
      .filter(([p]) => folderOf(p) === folder)
      .flatMap(([, data]) => (Array.isArray(data) ? data : []));
    registry.push({ folder, durationId, authors, texts });
  });
  return registry;
}

export default function Timeline() {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);

  const axisRef = useRef(null);
  const gridRef = useRef(null);
  const outlinesRef = useRef(null);
  const segmentsRef = useRef(null);
  const authorsRef = useRef(null);
  const textsRef = useRef(null);
  const prevZoomedInRef = useRef(false);
  const hoveredDurationIdRef = useRef(null);
  const zoomDraggingRef = useRef(false);

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
  const [selectedAuthor, setSelectedAuthor] = useState(null);
  const [showMoreAuthor, setShowMoreAuthor] = useState(false);
  const [authorCardPos, setAuthorCardPos] = useState({ left: 16, top: 16 });
  const closeAll = () => {
    setSelectedText(null);
    setSelectedAuthor(null);
    setShowMore(false);
    setShowMoreAuthor(false);
  };
  const modalOpen = !!(selectedText || selectedAuthor);
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

  /* ---- Ticks ---- */
  const tickAstro = useMemo(() => {
    const human = [];
    for (let y = -7000; y <= 2000; y += 500) if (y !== 0) human.push(y);
    const astro = human.map(toAstronomical);
    astro.push(0.5);
    astro.sort((a, b) => a - b);
    return astro;
  }, []);
  const formatTick = (a) => (Math.abs(a - 0.5) < 1e-6 ? "0" : formatYear(fromAstronomical(a)));

  /* ---- Prepare composite OUTLINES ---- */
  const DEFAULT_BAR_PX = 24;
  const outlines = useMemo(() => {
    const rows = durations
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
          // fields for the duration card
          expandedName: d["expanded name"] || d.name || "",
          broadLifespan: d["broad lifespan"] || "",
          broadNote: d["broad note"] || "",
        };
      });
    return rows;
  }, [durations, innerHeight]);

  /* ---- Segment hover rects ---- */
  const segments = useMemo(() => {
    const rows = [];
    for (const d of durations) {
      if (!Array.isArray(d.segments)) continue;
      const color = d.color || "#999";
      const y = d.yRel != null ? d.yRel * innerHeight : d.y != null ? d.y : 0;
      const h =
        d.hRel != null ? d.hRel * innerHeight : d.height != null ? d.height : DEFAULT_BAR_PX;

      d.segments.forEach((s, i) => {
        rows.push({
          id: `${d.id}__seg_${i}`,
          parentId: d.id,
          parentColor: color,
          start: s.start,
          end: s.end,
          y,
          h,
          label: s.label,
          tag: s.tag,
          note: s.note, // NOTE included
        });
      });
    }
    return rows;
  }, [durations, innerHeight]);

  /* ---- Datasets ---- */
  const datasetRegistry = useDiscoveredDatasets();

  /* ---- Authors & Texts rows ---- */
  const { authorRows, textRows } = useMemo(() => {
    const outlinesById = new Map(outlines.map((o) => [o.id, o]));
    const rowsA = [];
    const rowsT = [];

    for (const ds of datasetRegistry) {
      const band = outlinesById.get(ds.durationId);
      if (!band) continue;

      const bandY = band.y;
      theLoop: {
        const bandH = band.h;
        const pad = Math.min(6, Math.max(2, bandH * 0.15));
        const yForKey = (key) => {
          const r = hashString(`${ds.durationId}::${key || "anon"}`);
          return bandY + pad + r * Math.max(1, bandH - 2 * pad);
        };

        // AUTHORS
        for (const a of ds.authors || []) {
          const name = (a["Author"] || a["author"] || "").trim();
          const displayBirth = (a["D.O.B."] || "").trim();
          const displayDeath = (a["D.O.D."] || "").trim();
          const socioPoliticalTags = (a["Socio-political Tags"] || "").trim();
          const symbolicSystemTags = (a["Symbolic System Tags"] || "").trim();
          const jungianArchetypesTags = (a["Jungian Archetypes Tags"] || "").trim();
          const category = (a["Category"] || "").trim();
          const shortDescription = (a["Short Description"] || "").trim();

          const birthNum = Number(a?.Dataviz_birth);
          const deathNum = Number(a?.Dataviz_death);
          if (!Number.isFinite(birthNum) || !Number.isFinite(deathNum)) continue;

          const color = pickSystemColor(symbolicSystemTags);
          const y = yForKey(name);

          rowsA.push({
            id: `${ds.durationId}__author__${name || hashString(JSON.stringify(a))}`,
            durationId: ds.durationId,
            name,
            start: birthNum,
            end: deathNum,
            y,
            color,
            displayBirth: displayBirth || formatYear(birthNum),
            displayDeath: displayDeath || formatYear(deathNum),
            socioPoliticalTags,
            symbolicSystemTags,
            jungianArchetypesTags,
            category,
            shortDescription,
          });
        }

        // TEXTS
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
          const textKey = `${authorName || "anon"}::${title || ""}::${when}`;
          const y = yForKey(textKey);
          const displayDate = approxDateStr || formatYear(when);

          rowsT.push({
            id: `${ds.durationId}__text__${title || hashString(JSON.stringify(t))}__${when}`,
            durationId: ds.durationId,
            when,
            y,
            color,
            title,
            authorName,
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
    }

    // Clamp to band extent
    const bandExtent = new Map(
      outlines.map((o) => [o.id, { min: Math.min(o.start, o.end), max: Math.max(o.start, o.end) }])
    );
    const filtA = rowsA.filter((r) => {
      const e = bandExtent.get(r.durationId);
      return e ? r.end >= e.min && r.start <= e.max : true;
    });
    const filtT = rowsT.filter((r) => {
      const e = bandExtent.get(r.durationId);
      return e ? r.when >= e.min && r.when <= e.max : true;
    });

    return { authorRows: filtA, textRows: filtT };
  }, [datasetRegistry, outlines]);

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
    const gOut = d3.select(outlinesRef.current);
    const gSeg = d3.select(segmentsRef.current);
    const gAuthors = d3.select(authorsRef.current);
    const gTexts = d3.select(textsRef.current);

    gRoot.attr("transform", `translate(${margin.left},${margin.top})`);

    const axisFor = (scale) => d3.axisBottom(scale).tickValues(tickAstro).tickFormat(formatTick);
    const gridFor = (scale) =>
      d3.axisBottom(scale).tickValues(tickAstro).tickSize(-innerHeight).tickFormat(() => "");

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

    // ----- Four tooltip DIVs -----
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
    const tipAuthor = makeTip("tl-author");
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

      // NOTE includes seg.note under the date line
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
      d3.select(outlinesRef.current)
        .selectAll("rect.outlineRect")
        .attr("stroke-opacity", (d) => {
          if (d.id === activeDurationId) return DUR_STROKE.activeOpacity;
          if (!ignoreHoverBecauseActive && d.id === hoveredDurationId) return DUR_STROKE.hoverOpacity;
          return DUR_STROKE.baseOpacity;
        })
        .attr("stroke-width", (d) => {
          if (d.id === activeDurationId) return DUR_STROKE.activeWidth;
          if (!ignoreHoverBecauseActive && d.id === hoveredDurationId) return DUR_STROKE.hoverWidth;
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
    }

    function clearActiveSegment() {
      activeSegIdRef.current = null;
      hoveredSegParentIdRef.current = null; 
      gSeg
        .selectAll("rect.segmentHit")
        .attr("stroke-opacity", 0.02)
        .attr("stroke-width", 1.5);
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
      gSeg
        .selectAll("rect.segmentHit")
        .attr("stroke-opacity", (d) => (d.id === seg.id ? 1 : 0.02))
        .attr("stroke-width", (d) => (d.id === seg.id ? 2 : 1.5));
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

    // Helper to preview highlight without changing active (segments)
    function previewSegmentHighlight(seg, on) {
      if (!seg) return;
      gSeg
        .selectAll("rect.segmentHit")
        .filter((d) => d.id === seg.id && d.id !== activeSegIdRef.current)
        .attr("stroke-opacity", on ? 0.5 : 0.02)
        .attr("stroke-width", on ? 2 : 1.5);
    }

    // Sync hovered duration from pointer while zooming (zoomed-out mode)
    function syncDurationHoverFromPointer(se) {
      if (!se || !("clientX" in se) || kRef.current >= ZOOM_THRESHOLD) return;
      const el = document.elementFromPoint(se.clientX, se.clientY);
      let newId = null;
      if (el && el.classList && el.classList.contains("outlineRect")) {
        const d = d3.select(el.parentNode).datum();
        newId = d?.id ?? null;
      }
      if (hoveredDurationIdRef.current !== newId) {
        hoveredDurationIdRef.current = newId;
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

    // Whole-duration hover/click (zoomed-out only)
   // Whole-duration hover (zoomed-out only)
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
  .on("click", function (ev, d) {               // <-- GET THE EVENT
    if (kRef.current >= ZOOM_THRESHOLD) return;

    // If awaiting a 'close' click, consume this click to close instead of opening a new one
    if (awaitingCloseClickRef.current) {
      awaitingCloseClickRef.current = false;
      clearActiveDuration();
      ev.stopPropagation();                     // <-- PREVENT ROOT HANDLER FROM SEEING THIS CLICK
      return;
    }

    // Open this duration, and arm one-shot close
    clearActiveSegment();
    setActiveDuration(d, { showCard: true });
    awaitingCloseClickRef.current = true;
    ev.stopPropagation();                       // <-- PREVENT IMMEDIATE CLOSE
  });


    // AUTHORS (lifespan lines)
    const authorSel = gAuthors
      .selectAll("line.author")
      .data(authorRows, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("line")
            .attr("class", "author")
            .attr("vector-effect", "non-scaling-stroke")
            .attr("stroke-linecap", "round")
            .attr("stroke", (d) => d.color || "#222")
            .attr("opacity", BASE_OPACITY)
            .attr("stroke-width", clamp(AUTHOR_BASE_STROKE * kRef.current, 1, 6))
            .style("transition", "stroke-width 120ms ease"),
        (update) => update,
        (exit) => exit.remove()
      );

    // TEXTS (dots)
    const textSel = gTexts
      .selectAll("circle.textDot")
      .data(textRows, (d) => d.id)
      .join(
        (enter) =>
          enter
            .append("circle")
            .attr("class", "textDot")
            .attr("fill", (d) => d.color || "#444")
            .attr("opacity", BASE_OPACITY)
            .attr("r", TEXT_BASE_R * kRef.current)
            .style("transition", "r 120ms ease"),
        (update) => update,
        (exit) => exit.remove()
      );

    // Small helpers
    const within = (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b);
    const overlaps = (a0, a1, b0, b1) => Math.max(a0, b0) <= Math.min(a1, b1);

    const findSegForAuthor = (d) =>
      segments.find(
        (s) =>
          s.parentId === d.durationId &&
          overlaps(Math.min(d.start, d.end), Math.max(d.start, d.end), s.start, s.end) &&
          within(d.y, s.y, s.y + s.h)
      );

    const findSegForText = (d) =>
      segments.find(
        (s) =>
          s.parentId === d.durationId &&
          d.when >= s.start &&
          d.when <= s.end &&
          within(d.y, s.y, s.y + s.h)
      );

    // Authors hover/click (zoomed-in only via pointer-events toggle)
    const authorEnterStroke = clamp(AUTHOR_BASE_STROKE * kRef.current, 1, 6);
    authorSel
      .on("mouseenter", function (_ev, d) {
        const k = kRef.current;
        d3.select(this)
          .attr("stroke-width", clamp(AUTHOR_BASE_STROKE * k * HOVER_SCALE_LINE, 1, 8))
          .attr("opacity", 1);

        // Preview segment border only (no card)
        const seg = findSegForAuthor(d);
        if (seg) previewSegmentHighlight(seg, true);

        const html = tipHTML(`${d.name || ""}`, ` ${fmtRange(d.start, d.end)}`);
        const a = authorAnchorClient(d);
        if (a) showTip(tipAuthor, html, a.x, a.y, d.color);
      })
      .on("mousemove", function (_ev, d) {
        const html = tipHTML(`${d.name || ""}`, `${fmtRange(d.start, d.end)}`);
        const a = authorAnchorClient(d);
        if (a) showTip(tipAuthor, html, a.x, a.y, d.color);
      })
      .on("mouseleave", function (_ev, d) {
        const k = kRef.current;
        d3.select(this).attr("stroke-width", clamp(AUTHOR_BASE_STROKE * k, 1, 6)).attr("opacity", BASE_OPACITY);
        hideTipSel(tipAuthor);

        const seg = findSegForAuthor(d);
        if (seg) previewSegmentHighlight(seg, false);
      })
      .on("click", function (ev, d) {
  clearActiveSegment(); // ← NEW: fully dismiss the segment + its box

  const a = authorAnchorClient(d);
  const wrapRect = wrapRef.current.getBoundingClientRect();

  const CARD_W = 420;
  const CARD_H = 360;
  const PAD = 12;

  let left = a ? a.x - wrapRect.left + PAD : PAD;
  let top = a ? a.y - wrapRect.top + PAD : PAD;

  left = Math.max(4, Math.min(left, wrapRect.width - CARD_W - 4));
  top = Math.max(4, Math.min(top, wrapRect.height - CARD_H - 4));

  hideTipSel(tipAuthor);
  hideTipSel(tipText);
  hideTipSel(tipSeg);
  hideTipSel(tipDur);

  setAuthorCardPos({ left, top });
  setSelectedAuthor(d);
  setShowMoreAuthor(false);

  ev.stopPropagation();
})
      .attr("stroke-width", authorEnterStroke)
      .attr("opacity", BASE_OPACITY);

    // Text dots hover/click (zoomed-in only via pointer-events toggle)
    textSel
      .on("mouseenter", function (_ev, d) {
        const k = kRef.current;
        d3.select(this).attr("r", TEXT_BASE_R * k * HOVER_SCALE_DOT).attr("opacity", 1);

        // Preview segment border only (no card)
        const seg = findSegForText(d);
        if (seg) previewSegmentHighlight(seg, true);

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
        d3.select(this).attr("r", TEXT_BASE_R * k).attr("opacity", BASE_OPACITY);
        hideTipSel(tipText);

        const seg = findSegForText(d);
        if (seg) previewSegmentHighlight(seg, false);
      })
      .on("click", function (ev, d) {
  clearActiveSegment(); // ← NEW: fully dismiss the segment + its box

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
  hideTipSel(tipAuthor);
  hideTipSel(tipSeg);
  hideTipSel(tipDur);

  setCardPos({ left, top });
  setSelectedText(d);
  setShowMore(false);

  ev.stopPropagation();
})
      .attr("opacity", BASE_OPACITY);

    function authorAnchorClient(d) {
      const zx = zxRef.current,
        zy = zyRef.current;
      if (!zx || !zy) return null;
      const svgRect = svgRef.current.getBoundingClientRect();

      const x0 = zx(toAstronomical(d.start));
      const x1 = zx(toAstronomical(d.end));
      const xMid = (Math.min(x0, x1) + Math.max(x0, x1)) / 2;
      const yLine = zy(d.y);

      return {
        x: svgRect.left + margin.left + xMid,
        y: svgRect.top + margin.top + yLine,
      };
    }

    function textAnchorClient(el, d) {
      const zx = zxRef.current,
        zy = zyRef.current;
      if (!zx || !zy) return null;
      const svgRect = svgRef.current.getBoundingClientRect();

      const cx = zx(toAstronomical(d.when));
      const cyAttr = el ? parseFloat(d3.select(el).attr("cy")) : zy(d.y);

      return {
        x: svgRect.left + margin.left + cx,
        y: svgRect.top + margin.top + cyAttr,
      };
    }

    

    function apply(zx, zy, k = 1) {
      // cache latest rescaled axes for anchored tooltips
      zxRef.current = zx;
      zyRef.current = zy;

      // axis & grid
      gAxis.attr("transform", `translate(${margin.left},${margin.top + axisY})`).call(axisFor(zx));
      gGrid.attr("transform", `translate(0,${axisY})`).call(gridFor(zx));
      snapGrid(zx);

      // outlines rects
      gOut.selectAll("rect.outlineRect").each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        d3.select(this).attr("x", Math.min(x0, x1)).attr("y", yTop).attr("width", Math.abs(x1 - x0)).attr("height", hPix);
      });

      // labels (zoom-relative font)
      const fontPx = LABEL_BASE_PX * k;
      gOut.selectAll("g.durationOutline").each(function (d) {
        const g = d3.select(this);
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        g.select("text.durationLabel")
          .attr("x", Math.min(x0, x1) + 4)
          .attr("y", yTop + hPix / 3)
          .style("font-size", `${fontPx}px`);
      });

      // segment hit rects
      gSeg.selectAll("rect.segmentHit").each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        d3.select(this).attr("x", Math.min(x0, x1)).attr("y", yTop).attr("width", Math.abs(x1 - x0)).attr("height", hPix);
      });

      // authors — positions + zoomed size (base state)
      const strokeW = clamp(AUTHOR_BASE_STROKE * k, 1, 6);
      gAuthors.selectAll("line.author").each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yPix = zy(d.y);
        d3.select(this)
          .attr("x1", Math.min(x0, x1))
          .attr("x2", Math.max(x0, x1))
          .attr("y1", yPix)
          .attr("y2", yPix)
          .attr("stroke-width", strokeW);
      });

      // texts — positions with collision-free vertical adjustment
      const r = TEXT_BASE_R * k;

      const laneStepPad = Math.max(1, Math.round(r * 0.15));
      const minDX = 2 * r + laneStepPad;
      const minDY = 2 * r + laneStepPad;
      const laneStep = 2 * r + laneStepPad;

      const outlineById = new Map(outlines.map((o) => [o.id, o]));
      const textsByBand = new Map();
      textRows.forEach((d) => {
        const arr = textsByBand.get(d.durationId) || [];
        arr.push(d);
        textsByBand.set(d.durationId, arr);
      });

      const adjustedCy = new Map();

      for (const [bandId, items] of textsByBand.entries()) {
        const band = outlineById.get(bandId);
        if (!band) continue;

        const bandTop = zy(band.y);
        {
          const bandBottom = zy(band.y + band.h);
          const bandHeight = bandBottom - bandTop;

          const placed = [];
          const sorted = items
            .map((d) => ({ d, cx: zx(toAstronomical(d.when)), baseCy: zy(d.y) }))
            .sort((a, b) => a.cx - b.cx);

          const maxLanes = Math.max(1, Math.floor(bandHeight / laneStep));

          for (const it of sorted) {
            let chosenCy = it.baseCy;
            let found = false;

            const offsets = [];
            for (let i = 0; i < maxLanes; i++) {
              if (i === 0) offsets.push(0);
              else {
                offsets.push(i * laneStep);
                offsets.push(-i * laneStep);
              }
            }

            for (const off of offsets) {
              const trialCy = Math.max(bandTop + r, Math.min(bandBottom - r, it.baseCy + off));
              let collides = false;
              for (let j = placed.length - 1; j >= 0; j--) {
                const p = placed[j];
                if (it.cx - p.cx > minDX) break;
                if (Math.abs(it.cx - p.cx) < minDX && Math.abs(trialCy - p.cy) < minDY) {
                  collides = true;
                  break;
                }
              }
              if (!collides) {
                chosenCy = trialCy;
                found = true;
                break;
              }
            }

            if (!found) chosenCy = Math.max(bandTop + r, Math.min(bandBottom - r, it.baseCy));

            adjustedCy.set(it.d.id, chosenCy);
            placed.push({ cx: it.cx, cy: chosenCy });
          }
        }
      }

      gTexts.selectAll("circle.textDot").each(function (d) {
        const cx = zx(toAstronomical(d.when));
        const cy = adjustedCy.get(d.id) ?? zy(d.y);
        d3.select(this).attr("cx", cx).attr("cy", cy).attr("r", r);
      });
    }

    function updateInteractivity(k) {
      const zoomedIn = k >= ZOOM_THRESHOLD;

      gOut.selectAll("rect.outlineRect").style("pointer-events", zoomedIn ? "none" : "all");
      gSeg.selectAll("rect.segmentHit").style("pointer-events", zoomedIn ? "all" : "none");
      gAuthors.selectAll("line.author").style("pointer-events", zoomedIn ? "all" : "none");
      gTexts.selectAll("circle.textDot").style("pointer-events", zoomedIn ? "all" : "none");

      if (!zoomedIn) {
        // segments disabled; keep duration hover if any, and clear segment state
        clearActiveSegment();
      } else {
        // entering zoomed-in mode: ensure duration card is hidden
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
          // HOVER: only highlight border, and brighten parent label
          .on("mouseenter", function (_ev, seg) {
            if (activeSegIdRef.current === seg.id) return;
            d3.select(this).attr("stroke-opacity", 0.5).attr("stroke-width", 2);

            hoveredSegParentIdRef.current = seg.parentId;
            updateHoverVisuals();
          })
          .on("mouseleave", function (_ev, seg) {
            if (zoomDraggingRef.current) return;
            if (activeSegIdRef.current === seg.id) return;
            d3.select(this).attr("stroke-opacity", 0.02).attr("stroke-width", 1.5);

            hoveredSegParentIdRef.current = null;
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
          // leaving whole-duration mode
          hoveredDurationIdRef.current = null;
          awaitingCloseClickRef.current = false; // reset one-shot close
          clearActiveDuration();                  // hide duration card when zooming in
          updateHoverVisuals();
        }

        if (!zoomedIn && wasZoomedIn) {
          // entering zoomed-out mode -> clear segment state
          clearActiveSegment();
          updateHoverVisuals();
        }

        prevZoomedInRef.current = zoomedIn;
      })
      .on("end", (event) => {
        zoomDraggingRef.current = false;
        // Final re-sync after the zoom settles
        syncDurationHoverFromPointer(event.sourceEvent);
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
      if (awaitingCloseClickRef.current) {
        awaitingCloseClickRef.current = false;
        clearActiveDuration();
        return;
      }
      const el = ev.target;
      const isSeg = el && el.classList && el.classList.contains("segmentHit");
      const isOutline = el && el.classList && el.classList.contains("outlineRect");
      if (!isSeg && !isOutline) {
        clearActiveSegment();
        clearActiveDuration();
      }
    });

    // Mark that we've initialized at least once
    didInitRef.current = true;

    // Hide tooltips if mouse leaves the whole svg area
    svgSel.on("mouseleave.tl-tip", () => {
      hideTipSel(tipAuthor);
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
    authorRows,
    textRows,
    width,
    height,
    innerWidth,
    innerHeight,
    axisY,
    margin.left,
    margin.top,
    tickAstro,
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
          <g ref={outlinesRef} className="durations" />
          <g ref={segmentsRef} className="segments" />
          <g ref={authorsRef} className="authors" />
          <g ref={textsRef} className="texts" />
        </g>
        <g ref={axisRef} className="axis" />
      </svg>

      {/* Backdrop for modal; closes on click */}
      {modalOpen && <div className="modalBackdrop" onClick={closeAll} />}

      {/* Author modal */}
      {selectedAuthor && (
        <AuthorCard
          d={selectedAuthor}
          left={authorCardPos.left}
          top={authorCardPos.top}
          showMore={showMoreAuthor}
          setShowMore={setShowMoreAuthor}
          onClose={closeAll}
        />
      )}

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
