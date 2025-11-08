// searchBar.jsx
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import "../styles/searchbar.css";
import MarkerIcon from "./markerIcon";

/* === Utils === */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/* === Highlight component === */
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

/* === Derive symbolic-system colors from item tags via global lookup === */
function deriveSymbolColorsFromItem(r) {
  // Prefer pre-provided props
  if (Array.isArray(r.colors) && r.colors.filter(Boolean).length > 1) {
    return { colors: r.colors.filter(Boolean) };
  }
  if (r.color) return { color: r.color };

  // Pull possible tag fields
  const raw =
    r.symbolic ??
    r.symbolicSystems ??
    r.symbolicSystem ??
    r.tags ??
    r.category ??
    r.tag;

  // Normalize to array of tokens
  const tokens = Array.isArray(raw)
    ? raw
    : String(raw || "")
        .split(/[;,/|]/)
        .map(s => s.trim())
        .filter(Boolean);

  // Global lookup injected by timeline (fallback to empty)
  const LOOKUP =
    (typeof window !== "undefined" && (window.SYMBOLIC_COLOR_LOOKUP || window.SYMBOLIC_COLOR_MAP)) ||
    {};

  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const lc = t.toLowerCase();
    const tc = t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
    const c = LOOKUP[t] || LOOKUP[lc] || LOOKUP[tc];
    if (c && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  }

  if (out.length > 1) return { colors: out };
  if (out.length === 1) return { color: out[0] };
  return {};
}

/**
 * Props:
 * - items: Array<...>
 * - onSelect: (item) => void
 * - placeholder?: string
 * - maxResults?: number
 * - onInteract?: () => void
 * - visibleIds?: Set<string>
 */
export default function SearchBar({
  items = [],
  onSelect = () => {},
  placeholder = "Search",
  maxResults = 12,
  onInteract = () => {},
  visibleIds,
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hoverIdx, setHoverIdx] = useState(0);
  const wrapRef = useRef(null);
  const inputRef = useRef(null);

  // Refs for auto-scrolling + keyboard/mouse nav mode
  const popoverRef = useRef(null);
  const itemRefs = useRef([]);
  const navModeRef = useRef("mouse");          // "mouse" | "keyboard"
  const navResetTimerRef = useRef(null);

  const setKeyboardNav = () => {
    navModeRef.current = "keyboard";
    if (navResetTimerRef.current) clearTimeout(navResetTimerRef.current);
    // After a short pause with no key navigation, allow mouse hover again
    navResetTimerRef.current = setTimeout(() => {
      navModeRef.current = "mouse";
      navResetTimerRef.current = null;
    }, 400);
  };

  useEffect(() => {
    return () => {
      if (navResetTimerRef.current) clearTimeout(navResetTimerRef.current);
    };
  }, []);

  useEffect(() => {}, [items, maxResults, visibleIds]);

  const listWasVisibleRef = useRef(false);

  const closeAndReset = () => {
    setOpen(false);
    setQ("");
    inputRef.current?.blur();
  };

  const results = useMemo(() => {
    const qq = q.trim().toLowerCase();
    const base = (visibleIds instanceof Set)
      ? items.filter(it => visibleIds.has(it.id))
      : items;

    if (!qq) {
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
    return base
      .map((it) => ({ it, s: score(it) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.it.title.localeCompare(b.it.title))
      .slice(0, maxResults)
      .map((x) => x.it);
  }, [q, items, maxResults, open, visibleIds]);

  // Reset hover to first when query changes
  useEffect(() => { setHoverIdx(0); }, [q]);

  // Reset item refs when results change
  useEffect(() => {
    itemRefs.current = [];
  }, [results]);

  // Close on outside click
  useEffect(() => {
    const handleOutside = (e) => {
      if (!(open && q.trim())) return;
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target)) {
        closeAndReset();
      }
    };
    document.addEventListener("pointerdown", handleOutside, true);
    return () => document.removeEventListener("pointerdown", handleOutside, true);
  }, [open, q]);

  // Notify when list first becomes visible
  useEffect(() => {
    const listVisible = !!(open && q.trim() && results.length > 0);
    if (listVisible && !listWasVisibleRef.current) {
      onInteract();
    }
    listWasVisibleRef.current = listVisible;
  }, [open, q, results, onInteract]);

  // Auto-scroll hovered item into view
  useEffect(() => {
    const container = popoverRef.current;
    const el = itemRefs.current[hoverIdx];
    if (!container || !el) return;

    const elTop = el.offsetTop;
    const elBottom = elTop + el.offsetHeight;
    const viewTop = container.scrollTop;
    const viewBottom = viewTop + container.clientHeight;

    if (elTop < viewTop) {
      container.scrollTop = elTop; // scroll up
    } else if (elBottom > viewBottom) {
      container.scrollTop = elBottom - container.clientHeight; // scroll down
    }
  }, [hoverIdx, results]);

  const activate = (idx) => {
    const item = results[idx];
    if (!item) return;
    onInteract();
    try {
      onSelect(item);
    } catch {
      /* swallow */
    }
    requestAnimationFrame(() => {
      closeAndReset();
    });
  };

  const onKeyDown = (e) => {
    if (!open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      setOpen(true);
      onInteract();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setKeyboardNav();
      setHoverIdx((i) => Math.min((results.length || 1) - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setKeyboardNav();
      setHoverIdx((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (open) {
        activate(hoverIdx);
      }
    } else if (e.key === "Escape" || e.key === "Esc") {
      e.preventDefault();
      closeAndReset();
    }
  };

  // When user moves the mouse inside the list, switch back to mouse mode
  const onPopoverMouseMove = () => {
    navModeRef.current = "mouse";
    if (navResetTimerRef.current) {
      clearTimeout(navResetTimerRef.current);
      navResetTimerRef.current = null;
    }
  };

  const maybeHoverByMouse = (idx) => {
    if (navModeRef.current === "keyboard") return; // ignore hover while keyboard nav is active
    setHoverIdx(idx);
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

    return (
      <button
        ref={(el) => (itemRefs.current[idx] = el)}
        key={r.id}
        className={`sb-item ${isHover ? "is-hover" : ""}`}
        onMouseEnter={() => maybeHoverByMouse(idx)}
        onMouseDown={(e) => {
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
            <MarkerIcon
              type="text"
              founding={false}
              historic={!!(r.historic ?? r.isHistoric)}
              {...deriveSymbolColorsFromItem(r)}
            />
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
        ref={(el) => (itemRefs.current[idx] = el)}
        key={r.id}
        className={`sb-item ${isHover ? "is-hover" : ""}`}
        onMouseEnter={() => maybeHoverByMouse(idx)}
        onMouseDown={(e) => {
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
            <MarkerIcon
              type="father"
              founding={!!r.founding}
              historic={!!(r.historic ?? r.isHistoric)}
              {...deriveSymbolColorsFromItem(r)}
            />
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
    document.body.classList.toggle("sb-open", listVisible);
    return () => document.body.classList.remove("sb-open");
  }, [listVisible]);

  return (
    <div ref={wrapRef} className="sb-wrap">
      <div className="sb-box" onMouseDown={() => { onInteract(); }}>
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
          onFocus={() => { setOpen(true); onInteract(); }}
          onChange={(e) => { setQ(e.target.value); }}
          onKeyDown={onKeyDown}
          aria-label="Search"
        />
      </div>

      {listVisible &&
        createPortal(
          <div
            className="sb-backdrop"
            onMouseDown={() => { closeAndReset(); }}
            aria-hidden="true"
          />,
          document.body
        )
      }

      {open && q.trim() && results.length > 0 && (
        <div
          ref={popoverRef}
          className="sb-popover"
          role="listbox"
          onMouseDown={() => { onInteract(); }}
          onMouseMove={onPopoverMouseMove}
        >
          {results.map((r, idx) => {
            const isHover = idx === hoverIdx;
            return r.type === "father"
              ? renderFatherItem(r, idx, isHover)
              : renderTextItem(r, idx, isHover);
          })}
        </div>
      )}

      {open && q.trim() && results.length === 0 && (
        <div className="sb-popover sb-empty" onMouseDown={() => { onInteract(); }}>
          No results
        </div>
      )}
    </div>
  );
}
