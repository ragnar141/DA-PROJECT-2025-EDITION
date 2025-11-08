// components/MarkerIcon.jsx
export default function MarkerIcon({
  type,
  color,
  colors,
  founding = false,
  historic = false,
  size = 16,
  midlineOffset = 0.22, // slight left shift of the historic midline
  className,
}) {
  const vb = "0 0 16 16";

  // ===== Fathers: right-pointing triangle with optional multi-color wedges =====
  if (type === "father") {
    const r = founding ? 5.5 : 4.0;
    const cx = 8, cy = 8;
    const xL = cx - r, xR = cx + r, yT = cy - r, yB = cy + r, yM = cy;
    const triPath = `M ${xL} ${yT} L ${xL} ${yB} L ${xR} ${yM} Z`;

    const palette = Array.isArray(colors) ? colors.filter(Boolean) : null;

    // Historic midline offset (to match your timeline style)
    const midX = Math.max(xL + 1, cx - r * midlineOffset);

    if (palette && palette.length > 1) {
      // Build N wedge triangles that share the right vertex (xR, yM).
      // Each wedge's base is a horizontal segment on the left edge (x = xL),
      // from y0 to y1, evenly partitioning [yT, yB].
      const n = palette.length;

      return (
        <svg
          viewBox={vb}
          width={size}
          height={size}
          focusable="false"
          aria-hidden="true"
          className={className}
        >
          {palette.map((c, i) => {
            const t0 = i / n;
            const t1 = (i + 1) / n;
            const y0 = yT + (yB - yT) * t0;
            const y1 = yT + (yB - yT) * t1;

            // Triangle wedge polygon:
            // left-top -> left-bottom of the slice -> right vertex
            const d = `M ${xL} ${y0} L ${xL} ${y1} L ${xR} ${yM} Z`;
            return <path key={i} d={d} fill={c} />;
          })}

          {historic && (
            <line
              x1={midX}
              x2={midX}
              y1={cy - r}
              y2={cy + r}
              stroke="#fff"
              strokeWidth="2"
              strokeLinecap="round"
            />
          )}
        </svg>
      );
    }

    // Single-color father fallback
    return (
      <svg
        viewBox={vb}
        width={size}
        height={size}
        focusable="false"
        aria-hidden="true"
        className={className}
      >
        <path d={triPath} fill={color || "#666"} />
        {historic && (
          <line
            x1={midX}
            x2={midX}
            y1={cy - r}
            y2={cy + r}
            stroke="#fff"
            strokeWidth="2"
            strokeLinecap="round"
          />
        )}
      </svg>
    );
  }

  // ===== Texts: multi-color pie if 2+ colors; else solid circle =====
  const palette = Array.isArray(colors) ? colors.filter(Boolean) : null;

  if (palette && palette.length > 1) {
    const n = palette.length;
    const cx = 8, cy = 8, r = 5.5;
    const arcs = [];

    if (n === 2) {
      // right half, left half
      arcs.push(arcPath(cx, cy, r, 0, Math.PI));
      arcs.push(arcPath(cx, cy, r, Math.PI, 2 * Math.PI));
    } else {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * 2 * Math.PI - Math.PI / 2;
        const a1 = ((i + 1) / n) * 2 * Math.PI - Math.PI / 2;
        arcs.push(arcPath(cx, cy, r, a0, a1));
      }
    }

    return (
      <svg
        viewBox={vb}
        width={size}
        height={size}
        focusable="false"
        aria-hidden="true"
        className={className}
      >
        {arcs.map((d, i) => (
          <path key={i} d={d} fill={palette[i]} />
        ))}
      </svg>
    );
  }

  // Single-color text fallback
  return (
    <svg
      viewBox={vb}
      width={size}
      height={size}
      focusable="false"
      aria-hidden="true"
      className={className}
    >
      <circle cx="8" cy="8" r="5.5" fill={color || "#666"} />
    </svg>
  );
}

function arcPath(cx, cy, r, a0, a1) {
  const x0 = cx + r * Math.cos(a0);
  const y0 = cy + r * Math.sin(a0);
  const x1 = cx + r * Math.cos(a1);
  const y1 = cy + r * Math.sin(a1);
  const sweep = 1; // clockwise
  const span = ((a1 - a0) + 2 * Math.PI) % (2 * Math.PI);
  const largeArc = span > Math.PI ? 1 : 0;
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${largeArc} ${sweep} ${x1} ${y1} Z`;
}
