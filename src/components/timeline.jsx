import { useEffect, useMemo, useRef, useState } from "react";
import * as d3 from "d3";
import data from "../data/durations.json";
import "../styles/timeline.css";

/* ===== BCE/CE helpers (no year 0) ===== */
const toAstronomical = (y) => (y <= 0 ? y + 1 : y);
const fromAstronomical = (a) => (a <= 0 ? a - 1 : a);
const formatYear = (y) => (y < 0 ? `${Math.abs(y)} BCE` : y > 0 ? `${y} CE` : "—");

export default function Timeline() {
  const wrapRef = useRef(null);
  const svgRef = useRef(null);
  const axisRef = useRef(null);
  const gridRef = useRef(null);
  const singlesRef = useRef(null);
  const compositesRef = useRef(null);

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
  const domainHuman = useMemo(() => [-6000, 2025], []);
  const domainAstro = useMemo(() => domainHuman.map(toAstronomical), [domainHuman]);

  // X: time scale; Y: identity (pixels->pixels) so we can rescale with zoom
  const x = useMemo(
    () => d3.scaleLinear().domain(domainAstro).range([0, innerWidth]),
    [domainAstro, innerWidth]
  );
  const y0 = useMemo(
    () => d3.scaleLinear().domain([0, innerHeight]).range([0, innerHeight]),
    [innerHeight]
  );

  /* ---- Ticks: every 500y + special "0", exclude 2025 ---- */
  const tickAstro = useMemo(() => {
    const human = [];
    for (let y = -6000; y <= 2000; y += 500) if (y !== 0) human.push(y);
    const astro = human.map(toAstronomical);
    astro.push(0.5); // draw as "0"
    astro.sort((a, b) => a - b);
    return astro;
  }, []);
  const formatTick = (a) => (Math.abs(a - 0.5) < 1e-6 ? "0" : formatYear(fromAstronomical(a)));

  /* ---- Data split: singles vs composites ---- */
  const DEFAULT_BAR_PX = 24;
  const { singles, composites } = useMemo(() => {
    const s = [];
    const c = [];
    for (const d of data) {
      if (Array.isArray(d.segments) && d.segments.length) c.push(d);
      else s.push(d);
    }
    return { singles: s, composites: c };
  }, []);

  /* ---- Resolve y/height for singles ---- */
  const singleRows = useMemo(() => {
    return singles.map((d, i) => {
      const y = d.yRel != null ? d.yRel * innerHeight : d.y != null ? d.y : i * 36;
      const h =
        d.hRel != null ? d.hRel * innerHeight : d.height != null ? d.height : DEFAULT_BAR_PX;
      return { ...d, y, h, color: d.color || "#4f46e5" };
    });
  }, [singles, innerHeight]);

  /* ---- Resolve segments for composites (inherit parent yRel/hRel if missing) ---- */
  const compositeRows = useMemo(() => {
    return composites.map((group) => {
      const baseColor = group.color || "#9ca3af";
      const segs = group.segments.map((s, i) => {
        const y =
          s.yRel != null
            ? s.yRel * innerHeight
            : s.y != null
            ? s.y
            : group.yRel != null
            ? group.yRel * innerHeight
            : group.y != null
            ? group.y
            : i * 36;

        const h =
          s.hRel != null
            ? s.hRel * innerHeight
            : s.height != null
            ? s.height
            : group.hRel != null
            ? group.hRel * innerHeight
            : group.height != null
            ? group.height
            : DEFAULT_BAR_PX;

        return {
          id: `${group.id}__seg_${i}`,
          start: s.start,
          end: s.end,
          y,
          h,
          color: s.color || baseColor
        };
      });
      return { id: group.id, name: group.name, color: baseColor, segments: segs };
    });
  }, [composites, innerHeight]);

  /* ========= Draw/Update ========= */
  useEffect(() => {
    const svg = d3.select(svgRef.current);
    const gRoot = svg.select("g.chart");
    const gAxis = d3.select(axisRef.current);
    const gGrid = d3.select(gridRef.current);
    const gSingles = d3.select(singlesRef.current);
    const gComposites = d3.select(compositesRef.current);

    gRoot.attr("transform", `translate(${margin.left},${margin.top})`);

    // JOIN singles
    const singleSel = gSingles
      .selectAll("g.bar.single")
      .data(singleRows, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "bar single");
        g.append("rect");
        g.append("text")
          .attr("class", "barLabel")
          .attr("dy", "0.32em")
          .style("dominant-baseline", "middle");
        return g;
      });

    // JOIN composites (one path per composite, + one label)
    const compSel = gComposites
      .selectAll("g.bar.composite")
      .data(compositeRows, (d) => d.id)
      .join((enter) => {
        const g = enter.append("g").attr("class", "bar composite");
        g.append("path")
          .attr("class", "compositeShape")
          .attr("stroke", "none")
          .attr("fill-rule", "nonzero");
        g.append("text")
          .attr("class", "barLabel")
          .attr("dy", "0.32em")
          .style("dominant-baseline", "middle");
        return g;
      });

    const axisFor = (scale) => d3.axisBottom(scale).tickValues(tickAstro).tickFormat(formatTick);
    const gridFor = (scale) =>
      d3.axisBottom(scale).tickValues(tickAstro).tickSize(-innerHeight).tickFormat(() => "");

    function apply(zx, zy) {
      // Axis anchored to bottom
      gAxis.attr("transform", `translate(${margin.left},${margin.top + axisY})`).call(axisFor(zx));

      // Grid (CSS handles stroke/dots)
      gGrid.attr("transform", `translate(0,${axisY})`).call(gridFor(zx));

      // Singles
      singleSel.attr("transform", (d) => {
        const x0 = zx(toAstronomical(d.start));
        const x1 = zx(toAstronomical(d.end));
        const yTop = zy(d.y);
        return `translate(${Math.min(x0, x1)},${yTop})`;
      });
      singleSel
        .select("rect")
        .attr("width", (d) =>
          Math.abs(zx(toAstronomical(d.end)) - zx(toAstronomical(d.start)))
        )
        .attr("height", (d) => zy(d.y + d.h) - zy(d.y))
        .attr("fill", (d) => d.color);
      singleSel
        .select("text")
        .attr("x", 8)
        .attr("y", (d) => (zy(d.y + d.h) - zy(d.y)) / 2)
        .text((d) => d.name);

      // Composites: union of rectangles as one path (no seams)
      compSel.each(function (grp) {
        const g = d3.select(this);
        const path = g.select("path.compositeShape");

        let dstr = "";
        let xLeft = Infinity;
        let topSeg = grp.segments[0] || { y: 0, h: 0 };

        grp.segments.forEach((s) => {
          const x0 = Math.min(zx(toAstronomical(s.start)), zx(toAstronomical(s.end)));
          const x1 = Math.max(zx(toAstronomical(s.start)), zx(toAstronomical(s.end)));
          const w = x1 - x0;
          const yTop = zy(s.y);
          const hPix = zy(s.y + s.h) - zy(s.y);
          dstr += `M ${x0},${yTop} h ${w} v ${hPix} h ${-w} Z `;
          if (x0 < xLeft) xLeft = x0;
          if (s && s.y < topSeg.y) topSeg = s;
        });

        path.attr("d", dstr).attr("fill", grp.color).attr("stroke", "none");

        const topY = zy(topSeg.y);
        const topH = zy(topSeg.y + topSeg.h) - zy(topSeg.y);

        g.select("text.barLabel")
          .attr("x", (isFinite(xLeft) ? xLeft : 0) + 8)
          .attr("y", topY + topH / 2)
          .text(grp.name);
      });
    }

    // initial draw (identity zoom)
    apply(x, y0);

    // zoom/pan (both axes)
    const zoom = d3
      .zoom()
      .scaleExtent([0.5, 24])
      .translateExtent([
        [0, 0],
        [innerWidth, innerHeight]
      ])
      .extent([
        [0, 0],
        [innerWidth, innerHeight]
      ])
      .on("zoom", (event) => {
        const t = event.transform;
        const zx = t.rescaleX(x);
        const zy = t.rescaleY(y0);
        apply(zx, zy);
      });

    d3.select(svgRef.current).call(zoom);

    return () => d3.select(svgRef.current).on(".zoom", null);
  }, [singleRows, compositeRows, width, height, innerWidth, innerHeight, axisY, margin.left, margin.top, tickAstro, x, y0]);

  return (
    <div ref={wrapRef} className="timelineWrap" style={{ width: "100%", height: "100%" }}>
      <svg ref={svgRef} className="timelineSvg" width={width} height={height}>
        <g className="chart" transform={`translate(${margin.left},${margin.top})`}>
          <g ref={gridRef} className="grid" />
          {/* composites behind singles so singles sit on top if overlapping */}
          <g ref={compositesRef} className="composites" />
          <g ref={singlesRef} className="bars" />
        </g>
        <g ref={axisRef} className="axis" />
      </svg>
    </div>
  );
}
