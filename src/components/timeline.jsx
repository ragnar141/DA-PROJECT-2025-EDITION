import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import durations from "../data/durations.json";
import "../styles/timeline.css";

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
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ===== Tooltip helpers ===== */
const fmtRange = (s, e) => `${formatYear(s)} – ${formatYear(e)}`;
const tipHTML = (title, subtitle) => `
  <div class="tl-tip-title">${title ?? ""}</div>
  ${subtitle ? `<div class="tl-tip-sub">${subtitle}</div>` : ""}
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

  // current zoom scale
  const kRef = useRef(1);
  // current rescaled axes for anchoring tooltips
  const zxRef = useRef(null);
  const zyRef = useRef(null);
  // hover lock counts per segment id
  const segHoverCounts = useRef(new Map());
  const activeSegIdRef = useRef(null); 

  /* ---- Responsive sizing ---- */
  const [size, setSize] = useState({ width: 800, height: 400 });
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
        return { id: d.id, name: d.name, color: d.color || "#999", start, end, y, h };
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
          note: s.note,
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
      const bandH = band.h;
      const pad = Math.min(6, Math.max(2, bandH * 0.15));
      const yForKey = (key) => {
        const r = hashString(`${ds.durationId}::${key || "anon"}`);
        return bandY + pad + r * Math.max(1, bandH - 2 * pad);
      };

      const authorY = new Map();

      // AUTHORS → unique lane per author
      for (const a of ds.authors || []) {
        const name = a?.Author ?? a?.author ?? "";
        const birth = Number(a?.Dataviz_birth);
        const death = Number(a?.Dataviz_death);
        if (!Number.isFinite(birth) || !Number.isFinite(death)) continue;
        const color = pickSystemColor(a?.["Symbolic System Tags"]);
        const y = yForKey(name);
        authorY.set(name, y);
        rowsA.push({
          id: `${ds.durationId}__author__${name || hashString(JSON.stringify(a))}`,
          durationId: ds.durationId,
          name,
          start: birth,
          end: death,
          y,
          color,
        });
      }

      // TEXTS → unique lane per text (not tied to author lane)
      for (const t of ds.texts || []) {
        const authorName = t?.Author ?? t?.author ?? "";
        const title = t?.Title ?? t?.title ?? t?.Name ?? "";
        const when = getTextDate(t);
        if (!Number.isFinite(when)) continue;
        const color = pickSystemColor(t?.["Symbolic System Tags"]);

        const textKey = `${authorName || "anon"}::${title || ""}::${when}`;
        const y = yForKey(textKey);

        rowsT.push({
          id: `${ds.durationId}__text__${title || hashString(JSON.stringify(t))}__${when}`,
          durationId: ds.durationId,
          title,
          authorName,
          when,
          y,
          color,
        });
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
    const tx = (innerWidth - innerWidth * s) / 2;
    const ty = (innerHeight - innerHeight * s) / 2;
    const t0 = d3.zoomIdentity.translate(tx, ty).scale(s);
    kRef.current = t0.k; // seed k for initial enter sizes

    // ----- Three tooltip DIVs (inside wrapper, above SVG) -----
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

    // helpers that need access to the tip elements
function hideTipSel(sel) {
  sel.style("opacity", 0).style("display", "none");
}

function hideSegTipIfUnlocked(segId) {
  const counts = segHoverCounts.current;
  const c = counts.get(segId) || 0;
  if (c <= 0 && activeSegIdRef.current === segId) {
    tipSeg.style("opacity", 0).style("display", "none");
    activeSegIdRef.current = null;
  }
}

    function hideAllTips() {
      tipAuthor.style("opacity", 0).style("display", "none");
      tipText.style("opacity", 0).style("display", "none");
      tipSeg.style("opacity", 0).style("display", "none");
    }

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

    // Show the segment tooltip anchored to the segment bar, not the cursor
    function showSegAnchored(seg) {
      const anchor = getSegmentAnchorPx(seg);
      if (!anchor) return;

      const wrapRect = wrapEl.getBoundingClientRect();

      tipSeg
        .html(tipHTML(seg.label || "", fmtRange(seg.start, seg.end)))
        .style("display", "block")
        .style("opacity", 1)
        .style("--accent", seg.parentColor || "");

        activeSegIdRef.current = seg.id;

      const node = tipSeg.node();
      const tw = node.offsetWidth;
      const th = node.offsetHeight;
      const pad = 8;

      // Prefer below the segment; flip above if it would overflow the wrapper bottom
      let x = anchor.xMid - tw / 2;
      let y = anchor.yTop + anchor.hPix + pad;
      let below = true;

      if (y + th > wrapRect.height) {
        y = anchor.yTop - th - pad;
        below = false;
      }

      // Clamp horizontally inside wrapper
      const maxX = wrapRect.width - tw - 4;
      x = Math.max(4, Math.min(x, maxX));

      tipSeg.style("left", `${x}px`).style("top", `${y}px`).classed("below", below);
    }

    // Get viewport coords for the mid-point of an author line
function authorAnchorClient(d) {
  const zx = zxRef.current, zy = zyRef.current;
  if (!zx || !zy) return null;
  const svgRect = svgRef.current.getBoundingClientRect();

  const x0 = zx(toAstronomical(d.start));
  const x1 = zx(toAstronomical(d.end));
  const xMid = (Math.min(x0, x1) + Math.max(x0, x1)) / 2;
  const yLine = zy(d.y);

  return {
    x: svgRect.left + margin.left + xMid,
    y: svgRect.top  + margin.top  + yLine,
  };
}

// Get viewport coords for a text dot (use the rendered cy)
function textAnchorClient(el, d) {
  const zx = zxRef.current, zy = zyRef.current;
  if (!zx || !zy) return null;
  const svgRect = svgRef.current.getBoundingClientRect();

  const cx = zx(toAstronomical(d.when));
  const cyAttr = el ? parseFloat(d3.select(el).attr("cy")) : zy(d.y);

  return {
    x: svgRect.left + margin.left + cx,
    y: svgRect.top  + margin.top  + cyAttr,
  };
}

    // OUTLINES (filled, no borders)
    const outlineSel = gOut
      .selectAll("g.durationOutline")
      .data(outlines, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "durationOutline").attr("data-id", (d) => d.id);

        g.append("rect")
          .attr("class", "outlineRect")
          .attr("fill", (d) => d.color)
          .attr("fill-opacity", 0.1)
          .attr("stroke", "none");

        g.append("text")
          .attr("class", "durationLabel")
          .attr("dy", "0.32em")
          .style("dominant-baseline", "middle")
          .attr("fill", (d) => d.color)
          .attr("opacity", 0.3)
          .style("font-weight", 600)
          .style("pointer-events", "none")
          .text((d) => d.name);

        return g;
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

    // ===== Hover helpers (only segments & labels react; dots/lines stay at 0.3) =====
    const within = (v, a, b) => v >= Math.min(a, b) && v <= Math.max(a, b);
    const overlaps = (a0, a1, b0, b1) => Math.max(a0, b0) <= Math.min(a1, b1);

    function updateHoverVisuals() {
      const counts = segHoverCounts.current;
      const activeSegs = segments.filter((s) => (counts.get(s.id) || 0) > 0);
      const activeParents = new Set(activeSegs.map((s) => s.parentId));
      gOut
        .selectAll("g.durationOutline")
        .select("text.durationLabel")
        .attr("opacity", (d) => (activeParents.has(d.id) ? 1 : 0.3));
    }

    // ===== SEGMENTS (hover hits) =====
    const segSel = gSeg
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
          .on("mouseenter", function (_ev, seg) {
            hoverOn(seg);
            showSegAnchored(seg);
          })
          .on("mousemove", function (_ev, seg) {
            // keep it anchored as you move within the segment
            showSegAnchored(seg);
          })
          .on("mouseleave", function (_ev, seg) {
            hoverOff(seg);
            
            setTimeout(() => hideSegTipIfUnlocked(seg.id), 0);

          })
      );

    function hoverOn(seg) {
      const m = segHoverCounts.current;
      const c = (m.get(seg.id) || 0) + 1;
      m.set(seg.id, c);
      if (c === 1) {
        segSel.filter((s) => s.id === seg.id).attr("stroke-opacity", 1).attr("stroke-width", 2);
      }
      updateHoverVisuals();
    }

    function hoverOff(seg) {
      setTimeout(() => {
        const m = segHoverCounts.current;
        const c = (m.get(seg.id) || 0) - 1;
        const nc = Math.max(0, c);
        m.set(seg.id, nc);
        if (nc === 0) {
          segSel
            .filter((s) => s.id === seg.id)
            .attr("stroke-opacity", 0.02)
            .attr("stroke-width", 1.5);
        }
        updateHoverVisuals();
      }, 0);
    }

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

    // Enlarge authors on hover + tooltip (cursor-follow)
    const authorEnterStroke = clamp(AUTHOR_BASE_STROKE * kRef.current, 1, 6);
    authorSel
      .on("mouseenter", function (ev, d) {
        const k = kRef.current;
        d3.select(this)
          .attr("stroke-width", clamp(AUTHOR_BASE_STROKE * k * HOVER_SCALE_LINE, 1, 8))
          .attr("opacity", 1);

          const seg = findSegForAuthor(d);
          if (seg) {
          hoverOn(seg);          // increase lock
          showSegAnchored(seg);  // keep the segment tooltip visible
       }

     const html = tipHTML(`Name: ${d.name || ""}`, `Dates: ${fmtRange(d.start, d.end)}`);
   const a = authorAnchorClient(d);
   if (a) showTip(tipAuthor, html, a.x, a.y, d.color);})
 .on("mousemove", function (_ev, d) {
   const html = tipHTML(`Name: ${d.name || ""}`, `Dates: ${fmtRange(d.start, d.end)}`);
   const a = authorAnchorClient(d);
   if (a) showTip(tipAuthor, html, a.x, a.y, d.color);
 })
     .on("mouseleave", function (_ev, d) {
  const k = kRef.current;
  d3.select(this)
    .attr("stroke-width", clamp(AUTHOR_BASE_STROKE * k, 1, 6))
    .attr("opacity", BASE_OPACITY);
  hideTipSel(tipAuthor);
  const seg = findSegForAuthor(d);
  if (seg) {
    hoverOff(seg);
    setTimeout(() => hideSegTipIfUnlocked(seg.id), 0);
  }
})

      .attr("stroke-width", authorEnterStroke)
      .attr("opacity", BASE_OPACITY);

    // Enlarge text dots on hover — proportional to zoom (no clamp) + tooltip (cursor-follow)
    textSel
      .on("mouseenter", function (ev, d) {
        const seg = findSegForText(d);
         if (seg) {
   hoverOn(seg);          // increase lock
   showSegAnchored(seg);  // keep the segment tooltip shown
  }
        const k = kRef.current;
        d3.select(this).attr("r", TEXT_BASE_R * k * HOVER_SCALE_DOT).attr("opacity", 1);

         const html = tipHTML(`Name: ${d.title || ""}`, `Approx. Date: ${formatYear(d.when)}`);
   const a = textAnchorClient(this, d);
   if (a) showTip(tipText, html, a.x, a.y, d.color);
      })
       .on("mousemove", function (_ev, d) {
   const html = tipHTML(`Name: ${d.title || ""}`, `Approx. Date: ${formatYear(d.when)}`);
   const a = textAnchorClient(this, d);
   if (a) showTip(tipText, html, a.x, a.y, d.color);
 })
      .on("mouseleave", function (_ev, d) {
  const seg = findSegForText(d);
  if (seg) hoverOff(seg);
  const k = kRef.current;
  d3.select(this).attr("r", TEXT_BASE_R * k).attr("opacity", BASE_OPACITY);
  hideTipSel(tipText);
  if (seg) setTimeout(() => hideSegTipIfUnlocked(seg.id), 0);
})

      .attr("opacity", BASE_OPACITY);

    function apply(zx, zy, k = 1) {
      // cache latest rescaled axes for anchored tooltips
      zxRef.current = zx;
      zyRef.current = zy;

      // axis & grid
      gAxis.attr("transform", `translate(${margin.left},${margin.top + axisY})`).call(axisFor(zx));
      gGrid.attr("transform", `translate(0,${axisY})`).call(gridFor(zx));
      snapGrid(zx);

      // outlines rects
      outlineSel.select("rect.outlineRect").each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        d3.select(this)
          .attr("x", Math.min(x0, x1))
          .attr("y", yTop)
          .attr("width", Math.abs(x1 - x0))
          .attr("height", hPix);
      });

      // labels (zoom-relative font)
      const fontPx = LABEL_BASE_PX * k;
      outlineSel.each(function (d) {
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
      segSel.each(function (d) {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        const hPix = zy(d.y + d.h) - zy(d.y);
        d3.select(this)
          .attr("x", Math.min(x0, x1))
          .attr("y", yTop)
          .attr("width", Math.abs(x1 - x0))
          .attr("height", hPix);
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

      // ===== texts — positions with collision-free vertical adjustment (uses r = TEXT_BASE_R * k) =====
      const r = TEXT_BASE_R * k;

      // Pads that scale with r
      const laneStepPad = Math.max(1, Math.round(r * 0.15));
      const minDX = 2 * r + laneStepPad; // horizontal neighborhood for collision
      const minDY = 2 * r + laneStepPad; // vertical clearance to avoid overlap
      const laneStep = 2 * r + laneStepPad;

      // Lookup for band bounds
      const outlineById = new Map(outlines.map((o) => [o.id, o]));

      // Group texts by band
      const textsByBand = new Map();
      textRows.forEach((d) => {
        const arr = textsByBand.get(d.durationId) || [];
        arr.push(d);
        textsByBand.set(d.durationId, arr);
      });

      // Compute adjusted cy (pixels) per circle id for this zoom frame
      const adjustedCy = new Map();

      for (const [bandId, items] of textsByBand.entries()) {
        const band = outlineById.get(bandId);
        if (!band) continue;

        const bandTop = zy(band.y);
        const bandBottom = zy(band.y + band.h);
        const bandHeight = bandBottom - bandTop;

        // Sort by x to check only nearby neighbors
        const placed = []; // {cx, cy}
        const sorted = items
          .map((d) => ({
            d,
            cx: zx(toAstronomical(d.when)),
            baseCy: zy(d.y),
          }))
          .sort((a, b) => a.cx - b.cx);

        // Maximum lane attempts that can fit
        const maxLanes = Math.max(1, Math.floor(bandHeight / laneStep));

        for (const it of sorted) {
          let chosenCy = it.baseCy;
          let found = false;

          // Try offsets around baseCy: 0, +1, -1, +2, -2, ...
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

            // Check collision only vs placed points within minDX neighborhood
            let collides = false;
            for (let j = placed.length - 1; j >= 0; j--) {
              const p = placed[j];
              if (it.cx - p.cx > minDX) break; // too far left to collide
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

      // Apply circle positions/sizes
      gTexts.selectAll("circle.textDot").each(function (d) {
        const cx = zx(toAstronomical(d.when));
        const cy = adjustedCy.get(d.id) ?? zy(d.y);
        d3.select(this).attr("cx", cx).attr("cy", cy).attr("r", r);
      });
    }

    // set up zoom
    const zoom = d3
      .zoom()
      .scaleExtent([MIN_ZOOM, MAX_ZOOM])
      .translateExtent([
        [0, 0],
        [innerWidth, innerHeight],
      ])
      .extent([
        [0, 0],
        [innerWidth, innerHeight],
      ])
      .on("zoom", (event) => {
        const t = event.transform;
        kRef.current = t.k;
        const zx = t.rescaleX(x);
        const zy = t.rescaleY(y0);
        apply(zx, zy, t.k);
      });

    const svgSel = d3.select(svgRef.current).call(zoom);

    // Hide all tooltips if mouse leaves the whole svg area
 svgSel.on("mouseleave.tl-tip", () => {
    hideTipSel(tipAuthor);
   hideTipSel(tipText);
   tipSeg.style("opacity", 0).style("display", "none");
   activeSegIdRef.current = null;
 });

    // FIRST DRAW at initial transform
    apply(t0.rescaleX(x), t0.rescaleY(y0), t0.k);

    // then set the zoom's internal state
    svgSel.call(zoom.transform, t0);

    return () => {
      d3.select(svgRef.current).on(".zoom", null);
      svgSel.on("mouseleave.tl-tip", null);
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
    <div ref={wrapRef} className="timelineWrap" style={{ width: "100%", height: "100%", position: "relative" }}>
      <svg ref={svgRef} className="timelineSvg" width={width} height={height}>
        <g className="chart" transform={`translate(${margin.left},${margin.top})`}>
          <g ref={gridRef} className="grid" />
          <g ref={outlinesRef} className="durations" />
          <g ref={segmentsRef} className="segments" />
          <g ref={authorsRef} className="authors" />
          <g ref={textsRef} className="texts" />
        </g>
        <g ref={axisRef} className="axis" />
      </svg>
    </div>
  );
}
