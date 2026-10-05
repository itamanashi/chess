/** Médaillon de marque : arbre des variantes, de bas en haut.
 * Une ligne (la position) monte puis se divise en trois suites ; le
 * nœud sauge marque la ligne principale. Hérite de la couleur du
 * parent pour le trait ivoire, dimensions via CSS. */
export default function BrandMark(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">
      <g stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
        <line x1={12} y1={20} x2={12} y2={13} />
        <line x1={12} y1={13} x2={6.5} y2={7} />
        <line x1={12} y1={13} x2={12} y2={6.5} />
        <line x1={12} y1={13} x2={17.5} y2={7} />
      </g>
      <circle cx={12} cy={20} r={1.6} fill="currentColor" />
      <circle cx={6.5} cy={7} r={1.6} stroke="currentColor" strokeWidth={1.8} />
      <circle cx={17.5} cy={7} r={1.6} stroke="currentColor" strokeWidth={1.8} />
      <circle cx={12} cy={6.5} r={2.2} style={{ fill: 'var(--success-text)' }} />
    </svg>
  );
}
