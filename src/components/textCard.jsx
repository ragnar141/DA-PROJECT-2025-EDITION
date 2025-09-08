import React from "react";

export default function TextCard({ d, left, top, onClose, showMore, setShowMore }) {
  if (!d) return null;

  const splitTags = (s) =>
    String(s || "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

  const Row = ({ label, value, className }) =>
    !value ? null : (
      <div className={`textCard-row ${className || ""}`}>
        {label && <span className="textCard-label">{label}</span>}
        <span className="textCard-value">{value}</span>
      </div>
    );

  // Only the Symbolic System row should pick up the accent color from the dot (d.color)
// ⬇️ Replace ONLY the SymbolicTagRow in TextCard with this
const SymbolicTagRow = ({ label, value }) => {
  const tags = splitTags(value);
  if (!tags.length) return null;

  // d.colors comes from Timeline: one color per symbolic system tag
  const colors = Array.isArray(d.colors) && d.colors.length ? d.colors : [];

  // picks the color for tag i; falls back to last known color, then d.color, then neutral
  const colorFor = (i) =>
    colors[i] || colors[colors.length - 1] || d.color || "#444";

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



  const showAuthor = d.authorName && d.authorName !== "-";
  const metaLocation = d.originalGeographicalLocation || d.originalGeo;

  return (
  <div className="textCard" style={{ position: "absolute", left, top }}>
    <button className="textCard-close" onClick={onClose} aria-label="Close">
      ×
    </button>

    {/* Title + Category centered with a dash */}
    <div className="textCard-titleCombo">
      <span className="textCard-title">{d.title}</span>
      {d.category && <span className="textCard-sep"> - </span>}
      {d.category && <span className="textCard-category">({d.category})</span>}
    </div>

    {/* Centered description */}
    <Row value={d.shortDescription} className="is-centered" />

    {/* Meta one-liner after description */}
    {(d.displayDate || metaLocation || d.originalLanguage) && (
      <div className="textCard-meta">
        {`composed in ${d.displayDate || "—"} in ${metaLocation || "—"}, in ${
          d.originalLanguage || "—"
        } language`}
        {d.authorName && d.authorName !== "-" && ` and attributed to ${d.authorName}`}
      </div>
    )}

    {/* Symbolic System uses accent color; ensure its wrapper aligns (class added inside component per earlier change) */}
    <SymbolicTagRow label="Symbolic System(s):" value={d.symbolicSystemTags} />
    <Row label="Comtean framework:" value={d.comteanFramework} />
    <Row label="Access Level:" value={d.accessLevel} />

    <div className="textCard-moreToggle">
      <button
        className="textCard-button"
        onClick={() => setShowMore((v) => !v)}
        aria-expanded={showMore ? "true" : "false"}
      >
        {showMore ? "Hide tags" : "Show tags"}
      </button>
    </div>

    {showMore && (
      <div className="textCard-more">
        <div className="textCard-row is-tags">
          <span className="textCard-label">Arts & Sciences:</span>
          <div className="textCard-tags">
            {splitTags(d.artsAndSciencesTags).map((t, i) => (
              <span key={`as-${i}`} className="textCard-tag">
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="textCard-row is-tags">
          <span className="textCard-label">Metaphysical:</span>
          <div className="textCard-tags">
            {splitTags(d.metaphysicalTags).map((t, i) => (
              <span key={`m-${i}`} className="textCard-tag">
                {t}
              </span>
            ))}
          </div>
        </div>

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
          <span className="textCard-label">Literary Forms:</span>
          <div className="textCard-tags">
            {splitTags(d.literaryFormsTags).map((t, i) => (
              <span key={`lf-${i}`} className="textCard-tag">
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="textCard-row is-tags">
          <span className="textCard-label">Literary Content:</span>
          <div className="textCard-tags">
            {splitTags(d.literaryContentTags).map((t, i) => (
              <span key={`lc-${i}`} className="textCard-tag">
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
