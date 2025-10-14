// searchBar.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/searchBar.css";

/* ===== verbose logging ===== */
const SB_DEBUG = true;
const dlog = (...args) => {
  if (!SB_DEBUG) return;
  // use console.log so it shows up even if "Verbose" is filtered off
  console.log("[SearchBar]", ...args);
};

/* === Tiny SVGs that mirror timeline glyphs (inline) === */
function MarkerIcon({ item }) {
  const type = item?.type;
  const color = item?.color || "#666";
  const colors = Array.isArray(item?.colors) ? item.colors.filter(Boolean) : null;
  const vb = "0 0 16 16";
  const MIDLINE_OFFSET = 0.22;

  if (type === "father") {
    const r = item?.founding ? 5.5 : 4.0;
    const cx = 8, cy = 8;
    const xL = cx - r, xR = cx + r, yT = cy - r, yB = cy + r, yM = cy;
    const midX = Math.max(xL + 1, cx - r * MIDLINE_OFFSET);
    const isHistoric = !!(item?.historic ?? item?.isHistoric);

    return (
      <svg viewBox={vb} width="16" height="16" focusable="false" aria-hidden="true">
        <path d={`M ${xL} ${yT} L ${xL} ${yB} L ${xR} ${yM} Z`} fill={color} />
        {isHistoric && (
          <line x1={midX} y1={cy - r} x2={midX} y2={cy + r} stroke="#fff" strokeWidth="2" strokeLinecap="round" />
        )}
      </svg>
    );
  }

  if (colors && colors.length > 1) {
    const n = colors.length;
    const cx = 8, cy = 8, r = 5.5;
    const paths = [];
    if (n === 2) {
      paths.push(arcPath(cx, cy, r, 0, Math.PI));
      paths.push(arcPath(cx, cy, r, Math.PI, 2 * Math.PI));
    } else {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * 2 * Math.PI - Math.PI / 2;
        const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
        paths.push(arcPath(cx, cy, r, a0, a1));
      }
    }
    return (
      <svg viewBox={vb} width="16" height="16" focusable="false" aria-hidden="true">
        {paths.map((d, i) => (
          <path key={i} d={d} fill={colors[i]} />
        ))}
      </svg>
    );
  }

  return (
    <svg viewBox={vb} width="16" height="16" focusable="false" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5" fill={color} />
    </svg>
  );
}

function durationLabelFromId(id) {
  if (!id) return null;
  if (id.startsWith("custom-")) {
    const m = id.match(/^custom-(.+?)-composite$/);
    return (m ? m[1] : id.slice("custom-".length)).trim();
  }
  const m = id.match(/^(.+?)-composite$/);
  return (m ? m[1] : id).trim();
}

function arcPath(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const sweep = 1;
  const largeArc = ((a1 - a0 + 2 * Math.PI) % (2 * Math.PI)) > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} ${sweep} ${x1} ${y1} Z`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* === Helpers for date/field handling === */
function cleanField(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return t && t !== "-" && t !== "—" ? t : null;
}
function formatYearHuman(y) {
  const n = Number(y);
  if (!Number.isFinite(n)) return null;
  if (n === 0) return "—";
  return n < 0 ? `${Math.abs(n)} BCE` : `${n} CE`;
}

function Highlight({ text, query }) {
  if (!text || !query) return <>{text}</>;
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return <>{text}</>;
  const rx = new RegExp(`(${words.map(escapeRegExp).join("|")})`, "ig");
  const parts = String(text).split(rx);
  return (
    <>
      {parts.map((part, i) =>
        rx.test(part) ? <mark key={i} className="sb-mark">{part}</mark> : <span key={i}>{part}</span>
      )}
    </>
  );
}

/**
 * Props:
 * - items: Array<{ id, type: "text"|"father", title, author?, date?, subtitle?, category?, description?, color?, colors?, founding?, index?, textIndex?, dob?, when?, durationId? }>
 * - onSelect: (item) => void
 * - placeholder?: string
 * - maxResults?: number
 * - onInteract?: () => void
 */
export default function SearchBar({
  items = [],
  onSelect = () => {},
  placeholder = "Search",
  maxResults = 12,
  onInteract = () => {},
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hoverIdx, setHoverIdx] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // mount/unmount trace
  useEffect(() => {
    dlog("mounted", { itemsCount: items?.length ?? 0 });
    return () => dlog("unmounted");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Trace props updates that matter
  useEffect(() => {
    dlog("props update", { itemsCount: items?.length ?? 0, maxResults });
  }, [items, maxResults]);

  // Track when the list transitions from hidden -> visible to fire onInteract once
  const listWasVisibleRef = useRef(false);

  const closeAndReset = () => {
    dlog("closeAndReset()");
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
  };

  const results = useMemo(() => {
    const qq = q.trim().toLowerCase();
    if (!qq) {
      dlog("results(empty query)", { open, q });
      return [];
    }
    const score = (it) => {
      let s = 0;
      const T = (v) => String(v || "").toLowerCase();
      const inc = (v, w) => (T(v).includes(qq) ? w : 0);
      s += inc(it.title, 8);
      s += inc(it.subtitle, 5);
      s += inc(it.category, 3);
      s += inc(it.description, 2);
      s += inc(it.index ?? it.textIndex, 1);
      s += inc(it.author, 4);
      s += inc(it.date, 2);
      s += inc(it.dob, 2);
      return s;
    };
    const out = items
      .map((it) => ({ it, s: score(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.it.title.localeCompare(b.it.title))
      .slice(0, maxResults)
      .map((x) => x.it);
    dlog("results(populated)", { q, count: out.length, sample: out.slice(0, 2) });
    return out;
  }, [q, items, maxResults, open]);

  useEffect(() => {
    setHoverIdx(0);
  }, [q]);

  // Close on any outside click/tap
  useEffect(() => {
    const handleOutside = (e) => {
      if (!(open && q.trim())) return;
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) {
        dlog("outside click → closeAndReset");
        closeAndReset();
      }
    };
    document.addEventListener("pointerdown", handleOutside, true);
    return () => document.removeEventListener("pointerdown", handleOutside, true);
  }, [open, q]);

  // Notify parent when list appears/disappears
  useEffect(() => {
    const listVisible = !!(open && q.trim() && results.length > 0);
    if (listVisible && !listWasVisibleRef.current) {
      dlog("list became visible");
      onInteract();
    }
    if (!listVisible && listWasVisibleRef.current) {
      dlog("list hidden");
    }
    listWasVisibleRef.current = listVisible;
  }, [open, q, results, onInteract]);

  const activate = (idx) => {
    const item = results[idx];
    if (!item) {
      dlog("activate: no item at idx", { idx });
      return;
    }
    dlog("activate", {
      idx,
      id: item.id,
      type: item.type,
      title: item.title,
      when: item.when,
      durationId: item.durationId,
      payload: item,
    });
    onInteract();
    try {
      dlog("onSelect → begin");
      onSelect(item); // Timeline should log from handleSearchSelect too
      dlog("onSelect → end");
    } catch (err) {
      console.log("[SearchBar] onSelect threw", err);
    }
    requestAnimationFrame(() => {
      dlog("rAF → closeAndReset");
      closeAndReset();
    });
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      onInteract();
      dlog("key", e.key, "→ open");
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHoverIdx((i) => Math.min((results.length || 1) - 1, i + 1));
      dlog("key ArrowDown → hoverIdx", Math.min((results.length || 1) - 1, hoverIdx + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHoverIdx((i) => Math.max(0, i - 1));
      dlog("key ArrowUp → hoverIdx", Math.max(0, hoverIdx - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) {
        dlog("key Enter → activate", { hoverIdx });
        activate(hoverIdx);
      }
    } else if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      dlog("key Escape → closeAndReset");
      closeAndReset();
    }
  };

  const renderTextItem = (r, idx, isHover) => {
    const rawAuthor =
      r.author ??
      (Array.isArray(r.authors) ? r.authors.filter(Boolean).join(", ") : null) ??
      r.subtitle;

    const author = (() => {
      if (rawAuthor == null) return null;
      const t = String(rawAuthor).trim();
      return t && t !== "-" ? t : null;
    })();

    const date =
      cleanField(r.date ?? r.year ?? r.dob) ??
      (Number.isFinite(Number(r.when)) ? formatYearHuman(r.when) : null);

    const idxDisplay = cleanField(r.index ?? r.textIndex);
    const durationLabel = r.durationId ? durationLabelFromId(r.durationId) : null;

    return (
      <button
        key={r.id}
        className={`sb-item ${isHover ? "is-hover" : ""}`}
        onMouseEnter={() => setHoverIdx(idx)}
        onMouseDown={(e) => {
          dlog("mouseDown(text item)", { idx, id: r.id, title: r.title });
          e.preventDefault();
          e.stopPropagation();
          activate(idx);
        }}
        role="option"
        aria-selected={isHover}
        type="button"
      >
        <div className="sb-line sb-line1">
          <span className="sb-inline-icon" aria-hidden="true">
            <MarkerIcon item={r} />
          </span>
          <span className="sb-title-text">
            <Highlight text={r.title} query={q} />
          </span>

          {date ? (
            <>
              <span className="sb-sep" />
              <span className="sb-date">
                <Highlight text={String(date)} query={q} />
              </span>
            </>
          ) : null}

          <span style={{ marginLeft: "auto" }} />

          {idxDisplay ? (
            <span className="sb-index" aria-hidden="true">
              <Highlight text={String(idxDisplay)} query={q} />
            </span>
          ) : null}
        </div>

        {author && (
          <div className="sb-line sb-line2 sb-author-line" style={{ display: "flex", alignItems: "baseline", gap: 0 }}>
            <div>
              {author ? (
                <>
                  <span className="sb-light">by</span>
                  <span className="sb-sep" />
                  <span className="sb-author">
                    <Highlight text={author} query={q} />
                  </span>
                </>
              ) : null}
            </div>

            <span style={{ marginLeft: "auto" }} />

            
          </div>
        )}

        {r.category ? (
          <div className="sb-line sb-line3">
            <span className="sb-category">
              <Highlight text={r.category} query={q} />
            </span>
          </div>
        ) : null}

        {r.description ? (
          <div className="sb-line sb-desc">
            <Highlight text={r.description} query={q} />
          </div>
        ) : null}
      </button>
    );
  };

  const renderFatherItem = (r, idx, isHover) => {
    const date =
      cleanField(r.dob ?? r.date) ??
      (Number.isFinite(Number(r.when)) ? formatYearHuman(r.when) : null);

    const idxDisplay = cleanField(r.index);
    const durationLabel = r.durationId ? durationLabelFromId(r.durationId) : null;

    return (
      <button
        key={r.id}
        className={`sb-item ${isHover ? "is-hover" : ""}`}
        onMouseEnter={() => setHoverIdx(idx)}
        onMouseDown={(e) => {
          dlog("mouseDown(father item)", { idx, id: r.id, title: r.title });
          e.preventDefault();
          e.stopPropagation();
          activate(idx);
        }}
        role="option"
        aria-selected={isHover}
        type="button"
      >
        <div className="sb-line sb-line1">
          <span className="sb-inline-icon" aria-hidden="true">
            <MarkerIcon item={r} />
          </span>
          <span className="sb-title-text">
            <Highlight text={r.title} query={q} />
          </span>
          {date ? (
            <>
              <span className="sb-sep" />
              <span className="sb-date">
                <Highlight text={String(date)} query={q} />
              </span>
            </>
          ) : null}

          <span style={{ marginLeft: "auto" }} />

          {idxDisplay ? (
            <span className="sb-index" aria-hidden="true">
              <Highlight text={String(idxDisplay)} query={q} />
            </span>
          ) : null}
        </div>

        {(r.category || durationLabel) && (
          <div className="sb-line sb-line2" style={{ display: "flex", alignItems: "baseline", gap: 0 }}>
            <div>
              {r.category ? (
                <span className="sb-category">
                  <Highlight text={r.category} query={q} />
                </span>
              ) : null}
            </div>

            <span style={{ marginLeft: "auto" }} />

            {durationLabel ? (
              <span className="sb-category sb-right-meta">
                <Highlight text={durationLabel} query={q} />
              </span>
            ) : null}
          </div>
        )}

        {r.description ? (
          <div className="sb-line sb-desc">
            <Highlight text={r.description} query={q} />
          </div>
        ) : null}
      </button>
    );
  };

  const listVisible = !!(open && q.trim() && results.length > 0);

  // keep body class in sync (used to dim the graph)
  useEffect(() => {
    dlog("listVisible changed", { listVisible });
    document.body.classList.toggle("sb-open", listVisible);
    return () => document.body.classList.remove("sb-open");
  }, [listVisible]);

  return (
    <div ref={wrapRef} className="sb-wrap">
      <div className="sb-box" onMouseDown={() => { dlog("sb-box mousedown"); onInteract(); }}>
        <svg className="sb-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            d="M21 21l-4.3-4.3m1.3-4.2a7 7 0 11-14 0 7 7 0 0114 0z"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>

        <input
          ref={inputRef}
          className="sb-input"
          type="text"
          value={q}
          placeholder={placeholder}
          onFocus={() => { dlog("input focus → open"); setOpen(true); onInteract(); }}
          onChange={(e) => { setQ(e.target.value); dlog("input change", { q: e.target.value }); }}
          onKeyDown={onKeyDown}
          aria-label="Search"
        />
      </div>

      {/* Backdrop via portal so it covers viewport and blocks graph interactions */}
      {listVisible &&
        createPortal(
          <div
            className="sb-backdrop"
            onMouseDown={() => { dlog("backdrop mousedown → closeAndReset"); closeAndReset(); }}
            aria-hidden="true"
          />,
          document.body
        )
      }

      {open && q.trim() && results.length > 0 && (
        <div className="sb-popover" role="listbox" onMouseDown={() => { dlog("popover mousedown"); onInteract(); }}>
          {results.map((r, idx) => {
            const isHover = idx === hoverIdx;
            return r.type === "father"
              ? renderFatherItem(r, idx, isHover)
              : renderTextItem(r, idx, isHover);
          })}
        </div>
      )}

      {open && q.trim() && results.length === 0 && (
        <div className="sb-popover sb-empty" onMouseDown={() => { dlog("popover(empty) mousedown"); onInteract(); }}>
          No results
        </div>
      )}
    </div>
  );
}
