import React from "react";
import "../styles/timeline.css";

export default function FatherCard({
  d,
  left = 16,
  top = 16,
  showMore = false,
  setShowMore = () => {},
  onClose = () => {},
}) {
  if (!d) return null;

  // Title: "Index Name"
  const title = [d.index, d.name].filter(Boolean).join(" ");

  // "Born/Emerged: <dob>, Died/Dissolved: <dod> in <location>"
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
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

  // Match TextCard classes/behavior so CSS applies 1:1 (chips, spacing, dashed divider)
  const Row = ({ label, value, className }) =>
    value ? (
      <div className={`textCard-row ${className || ""}`}>
        {label && <span className="textCard-label">{label}</span>}
        <span className="textCard-value">{value}</span>
      </div>
    ) : null;

  // Symbolic System chips — mirror TextCard logic (per-tag color if d.colors provided)
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
      className="fatherCard"
      style={{
        // Centered modal; keep as-is. If you later anchor it, pass {left, top} and add absolute positioning.
      }}
      role="dialog"
      aria-label={`Details for ${title}`}
    >
      <button className="textCard-close" onClick={onClose} aria-label="Close">
        ×
      </button>

      {/* Title + Category (same classes as TextCard) */}
      <div className="textCard-titleCombo">
        <span className="textCard-title">{title}</span>
        {d.category && <span className="textCard-sep"> - </span>}
        {d.category && <span className="textCard-category">({d.category})</span>}
      </div>

      {/* Centered description */}
      <Row value={d.description} className="is-centered" />

      {/* Small meta line */}
      {metaLine && <div className="textCard-meta">{metaLine}</div>}

      {/* Primary rows (outside of the dashed divider, just like TextCard) */}
      <SymbolicTagRow label="Symbolic System(s):" value={d.symbolicSystem} />
      <Row label="Comtean framework:" value={d.comteanFramework} />

      {/* Toggle */}
      <div className="textCard-moreToggle">
        <button
          className="textCard-button"
          onClick={() => setShowMore(!showMore)}
          aria-expanded={showMore ? "true" : "false"}
        >
          {showMore ? "Hide tags" : "Show tags"}
        </button>
      </div>

      {/* Expanded area — exact same structure/classes as TextCard so the dashed line appears */}
      {showMore && (
        <div className="textCard-more">
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

          <div className="textCard-row is-tags">
            <span className="textCard-label">Socio-political:</span>
            <div className="textCard-tags">
              {splitTags(d.socioPoliticalTags).map((t, i) => (
                <span key={`sp-${i}`} className="textCard-tag">
                  {t}
                </span>
              ))}
            </div>
          </div>

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
}
