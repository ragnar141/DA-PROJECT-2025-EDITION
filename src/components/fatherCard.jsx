import React, {
  forwardRef,
  useRef,
  useState,
  useEffect,
  useImperativeHandle,
} from "react";
import "../styles/timeline.css";

const FatherCard = forwardRef(function FatherCard(
  { d, left = 16, top = 16, showMore = false, setShowMore = () => {}, onClose = () => {} },
  ref
) {
  if (!d) return null;

  const elRef = useRef(null);
  const [isClosing, setIsClosing] = useState(false);
  const closedOnceRef = useRef(false);

  useImperativeHandle(ref, () => ({
    startClose: () => {
      if (!isClosing) setIsClosing(true);
    },
  }));

  // Animate out then call onClose
  useEffect(() => {
    if (!isClosing || !elRef.current) return;
    const el = elRef.current;

    el.classList.remove("tl-slideIn");
    el.classList.add("tl-slideOut");

    const handleDone = () => {
      if (closedOnceRef.current) return;
      closedOnceRef.current = true;
      onClose?.();
    };
    el.addEventListener("animationend", handleDone, { once: true });
    return () => el.removeEventListener("animationend", handleDone);
  }, [isClosing, onClose]);

  // Close on Esc (capture; ignore when search list is open)
  useEffect(() => {
    const onKeyDown = (e) => {
      const key = e.key || e.code;
      if (key !== "Escape" && key !== "Esc") return;
      if (document.body.classList.contains("sb-open")) return;
      e.preventDefault();
      e.stopPropagation();
      setIsClosing(true);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // Title & small utils
  const title = d.name || "";
  const indexStr = (d.index ?? "").toString().trim();

  const dateBits = [];
  if (d.dob) dateBits.push(`Born/Emerged: ${d.dob}`);
  if (d.dod) dateBits.push(`Died/Dissolved: ${d.dod}`);
  let metaLine = "";
  if (dateBits.length) {
    metaLine = dateBits.join(", ");
    if (d.location) metaLine += ` in ${d.location}`;
  } else if (d.location) {
    metaLine = `Location: ${d.location}`;
  }

  const splitTags = (s) =>
    String(s || "")
      .split(/[;,]/) // accept commas/semicolons
      .map((t) => t.trim())
      .filter(Boolean)
      .filter((t) => t !== "-"); // treat "-" as NA

  const Row = ({ label, value, className }) =>
    value ? (
      <div className={`textCard-row ${className || ""}`}>
        {label && <span className="textCard-label">{label}</span>}
        <span className="textCard-value">{value}</span>
      </div>
    ) : null;

  const SymbolicTagRow = ({ label, value }) => {
    const tags = splitTags(value);
    if (!tags.length) return null;
    const colors = Array.isArray(d.colors) && d.colors.length ? d.colors : [];
    const colorFor = (i) => colors[i] || colors[colors.length - 1] || d.color || "#444";
    return (
      <div className="textCard-row is-tags">
        <span className="textCard-label">{label}</span>
        <div className="textCard-tags">
          {tags.map((t, i) => (
            <span
              key={i}
              className="textCard-tag"
              style={{ borderColor: colorFor(i), color: colorFor(i) }}
            >
              {t}
            </span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div
      ref={elRef}
      className="fatherCard tl-slideIn"
      style={{ position: "absolute", left, top }}
      role="dialog"
      aria-label={`Details for ${title}`}
    >
      {indexStr && <span className="textCard-index">{indexStr}</span>}

      <button
        className="textCard-close"
        onClick={() => setIsClosing(true)}
        aria-label="Close"
      >
        ×
      </button>

      <div className="textCard-titleCombo">
        <span className="textCard-title">{title}</span>
        {d.category && <span className="textCard-sep"> - </span>}
        {d.category && <span className="textCard-category">{d.category}</span>}
        {/* Founding Figure chip removed */}
      </div>

      <Row value={d.description} className="is-centered" />

      {metaLine && <div className="textCard-meta">{metaLine}</div>}

      {/* Symbolic systems */}
      <SymbolicTagRow label="Symbolic System(s):" value={d.symbolicSystem} />

      <div className="textCard-moreToggle">
        <button
          className="textCard-button"
          onClick={() => setShowMore(!showMore)}
          aria-expanded={showMore ? "true" : "false"}
        >
          {showMore ? "Hide tags" : "Show tags"}
        </button>
      </div>

      {showMore && (
        <div className="textCard-more">
          {/* Jungian */}
          <div className="textCard-row is-tags">
            <span className="textCard-label">Jungian Archetypes:</span>
            <div className="textCard-tags">
              {splitTags(d.jungianArchetypesTags).map((t, i) => (
                <span key={`ja-${i}`} className="textCard-tag">
                  {t}
                </span>
              ))}
            </div>
          </div>

          {/* Neumann */}
          <div className="textCard-row is-tags">
            <span className="textCard-label">Neumann Stages:</span>
            <div className="textCard-tags">
              {splitTags(d.neumannStagesTags).map((t, i) => (
                <span key={`ns-${i}`} className="textCard-tag">
                  {t}
                </span>
              ))}
            </div>
          </div>

          {/* Historic/Mythic */}
          <div className="textCard-row is-tags">
            <span className="textCard-label">Historic-Mythic Status:</span>
            <div className="textCard-tags">
              {splitTags(d.historicMythicStatusTags).map((t, i) => (
                <span key={`hm-${i}`} className="textCard-tag">
                  {t}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
});

export default FatherCard;
