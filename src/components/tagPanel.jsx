import { useState, useMemo, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import "../styles/tagPanel.css";

/* Simple portal so the dropdown renders at <body> level */
function MenuPortal({ children }) {
  return createPortal(children, document.body);
}

/**
 * TagPanel — controlled filter panel (dropdowns portaled to <body>)
 * Props:
 *  - groups: [{ key, label, appliesTo, allTags: string[] }]
 *  - selectedByGroup: { [key: string]: Set<string> }
 *  - onChange: (nextSelectedByGroup) => void
 */
export default function TagPanel({ groups, selectedByGroup, onChange }) {
  const [openKey, setOpenKey] = useState(null);   // which group's menu is open
  const [isOpen, setIsOpen] = useState(false);    // slide-out state (false = hidden)

  const panelRef = useRef(null);
  const menuRef = useRef(null);                   // portal menu container
  const btnRefs = useRef(new Map());              // trigger buttons by group key

  // Floating menu position (fixed coords)
  const [menuPos, setMenuPos] = useState({ top: 0, left: 0, width: 320 });

  // ---- Tweakables (keep MENU_WIDTH in sync with CSS) ----
  const MENU_WIDTH = 230;
  const GAP = 12;
  const EXTRA_LEFT = 16;
  const VIEWPAD = 8;

  // Convert Sets to quick lookup for rendering (memoized)
  const selectedMaps = useMemo(() => {
    const m = new Map();
    for (const g of groups) {
      const set = selectedByGroup[g.key] || new Set();
      m.set(g.key, set);
    }
    return m;
  }, [groups, selectedByGroup]);

  const toggleMenu = (key) => {
    setOpenKey((prev) => (prev === key ? null : key));
  };

  const handleToggleTag = (groupKey, tag) => {
    const current = selectedByGroup[groupKey] || new Set();
    const next = new Set(current);
    if (next.has(tag)) next.delete(tag);
    else next.add(tag);
    onChange({ ...selectedByGroup, [groupKey]: next });
  };

  const handleAll = (groupKey, allTags) => {
    onChange({ ...selectedByGroup, [groupKey]: new Set(allTags) });
  };

  const handleNone = (groupKey) => {
    onChange({ ...selectedByGroup, [groupKey]: new Set() });
  };

  const handleTogglePanel = () => {
    if (isOpen) setOpenKey(null);
    setIsOpen((v) => !v);
  };

  // Close on outside click + Esc (CAPTURE phase so nothing can block it)
  useEffect(() => {
    if (!isOpen) return;

    const onDocDown = (e) => {
      const panelEl = panelRef.current;
      const portalEl = menuRef.current;
      if ((panelEl && panelEl.contains(e.target)) || (portalEl && portalEl.contains(e.target))) {
        return;
      }
      setIsOpen(false);
      setOpenKey(null);
    };

    const onKey = (e) => {
      if (e.key === "Escape") {
        setIsOpen(false);
        setOpenKey(null);
      }
    };

    document.addEventListener("pointerdown", onDocDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDocDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [isOpen]);

  // Reposition the floating menu on scroll/resize while open
  useEffect(() => {
    if (!openKey) return;
    const onWin = () => positionMenu({ measure: true });
    window.addEventListener("scroll", onWin, true);
    window.addEventListener("resize", onWin);
    return () => {
      window.removeEventListener("scroll", onWin, true);
      window.removeEventListener("resize", onWin);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey]);

  // When a menu opens, position it on the next frame so we can measure height
  useEffect(() => {
    if (!openKey) return;
    const r1 = requestAnimationFrame(() => {
      const r2 = requestAnimationFrame(() => positionMenu({ measure: true }));
      return () => cancelAnimationFrame(r2);
    });
    return () => cancelAnimationFrame(r1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openKey, isOpen]);

  // ---- Forced order + two section labels ----
  const ORDER = [
    "__regular__",
    "symbolicSystems",
    "artsSciences",
    "literaryForms",
    "literaryContent",
    "socioPolitical",
    "__special__",
    "comtean",
    "metaphysical",
    "jungian",
    "neumann",
  ];

  const groupsByKey = useMemo(() => new Map(groups.map((g) => [g.key, g])), [groups]);

  const orderedGroups = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const key of ORDER) {
      if (key === "__regular__") {
        out.push({ __section: true, label: "Regular Tags", key });
        continue;
      }
      if (key === "__special__") {
        out.push({ __section: true, label: "Specialized Tags", key });
        continue;
      }
      const g = groupsByKey.get(key);
      if (g) {
        out.push(g);
        seen.add(key);
      }
    }
    for (const g of groups) {
      if (!seen.has(g.key)) out.push(g);
    }
    return out;
  }, [groups, groupsByKey]);

  // ---- Floating menu positioning (relative to the PANEL, not the button) ----
  function positionMenu({ measure = false } = {}) {
    const panelEl = panelRef.current;
    if (!panelEl) return;

    const panelRect = panelEl.getBoundingClientRect();

    const width = MENU_WIDTH;
    let left = panelRect.left - width - GAP - EXTRA_LEFT;

    const panelCenter = panelRect.top + panelRect.height / 2;

    let menuH = 300;
    if (measure && menuRef.current && menuRef.current.offsetHeight) {
      menuH = menuRef.current.offsetHeight;
    }

    let top = Math.round(panelCenter - menuH / 2);

    const minTop = VIEWPAD;
    const maxTop = Math.max(VIEWPAD, window.innerHeight - menuH - VIEWPAD);
    if (top < minTop) top = minTop;
    if (top > maxTop) top = maxTop;

    const minLeft = 4;
    if (left < minLeft) left = minLeft;

    setMenuPos({ top, left, width });
  }

  // --- badge helper (local) ---
  function renderCountBadge(count, total) {
    const text = `${count}/${total}`;
    return (
      <span className="tagPanel__badge" aria-label={`${count} of ${total} selected`}>
        {text}
      </span>
    );
  }

  return (
  <div
    id="tagPanel"
    ref={panelRef}
    className={`tagPanelWrap ${isOpen ? "tagPanelWrap--open" : "tagPanelWrap--closed"}`}
    aria-hidden={!isOpen}
    onMouseDown={(e) => e.stopPropagation()}
  >
    {/* FILTERS tab */}
    <button
      type="button"
      className="tagPanel__tab"
      aria-expanded={isOpen}
      aria-controls="tagPanel"
      aria-hidden={isOpen}
      tabIndex={isOpen ? -1 : 0}
      onClick={() => {
        setIsOpen(true);
        setOpenKey(null);
      }}
      title="Toggle filters"
    >
      FILTERS
    </button>

    {/* Panel X close */}
    {isOpen && (
      <button
        type="button"
        className="tagPanel__close tagPanel__panelClosePos"
        aria-label="Close filters"
        title="Close"
        onClick={() => {
          setIsOpen(false);
          setOpenKey(null);
        }}
      >
        ×
      </button>
    )}

    {/* Panel content */}
    <div className="tagPanel__content">
      {orderedGroups.map((g) => {
        if (g.__section) {
          return (
            <div key={g.key} className="tagPanel__sectionLabel">
              {g.label}
            </div>
          );
        }

        const set = selectedMaps.get(g.key) || new Set();
        const total = g.allTags.length;
        const count = set.size;
        const isDropdownOpen = openKey === g.key;

        // two-column normalized checklist for Symbolic Systems
        const items = [...g.allTags].sort((a, b) =>
          a.localeCompare(b, "en", { sensitivity: "base" })
        );
        const listClass =
          g.key === "symbolicSystems"
            ? "tagPanel__menuList tagPanel__menuList--twoCols"
            : "tagPanel__menuList";

        return (
          <div key={g.key} style={{ position: "relative" }}>
            <button
              type="button"
              ref={(el) => {
                if (el) btnRefs.current.set(g.key, el);
                else btnRefs.current.delete(g.key);
              }}
              onClick={() => toggleMenu(g.key)}
              className="tagPanel__btn"
              aria-expanded={isDropdownOpen}
              aria-controls={`menu-${g.key}`}
              title={g.label}
            >
              {g.label} {renderCountBadge(count, total)}
            </button>

            {isDropdownOpen && (
              <MenuPortal>
                <div
                  ref={menuRef}
                  id={`menu-${g.key}`}
                  role="menu"
                  className="tagPanel__dropdown"
                  style={{
                    position: "fixed",
                    top: `${menuPos.top}px`,
                    left: `${menuPos.left}px`,
                    width: `${menuPos.width}px`,
                    maxHeight: "calc(100vh - 32px)",
                    overflow: "auto",
                    zIndex: 9999,
                    transform: "none",
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  onClick={(e) => e.stopPropagation()}
                >
                  {/* Header (title + corner X) */}
                  <div className="tagPanel__menuHeader">
                    <span style={{ fontWeight: 600 }}>{g.label}</span>
                    <button
                      type="button"
                      className="tagPanel__close tagPanel__close--menu"
                      aria-label="Close menu"
                      title="Close"
                      onClick={() => setOpenKey(null)}
                    >
                      ×
                    </button>
                  </div>

                  {/* Toolbar under divider, aligned with first tag */}
                  <div className="tagPanel__toolbar">
                    <button
                      type="button"
                      onClick={() => handleAll(g.key, g.allTags)}
                      className="tagPanel__miniBtn"
                    >
                      All
                    </button>
                    <button
                      type="button"
                      onClick={() => handleNone(g.key)}
                      className="tagPanel__miniBtn"
                    >
                      None
                    </button>
                  </div>

                  {/* List */}
                  <div className={listClass}>
                    {items.map((tag) => {
                      const checked = set.has(tag);
                      return (
                        <label key={tag} className="tagPanel__row">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => handleToggleTag(g.key, tag)}
                          />
                          <span style={{ marginLeft: 8 }}>{tag}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              </MenuPortal>
            )}
          </div>
        );
      })}
    </div>
  </div>
);

}
