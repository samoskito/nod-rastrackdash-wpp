export default function ProductRouteLoading() {
  return (
    <section
      className="page-stack route-loading"
      aria-busy="true"
      aria-label="Carregando página"
    >
      {/* Same shape as PageBar: a short title and the actions on one row. */}
      <div className="page-bar route-loading-bar" aria-hidden="true">
        <span className="skeleton-line skeleton-bar-title" />
        <span className="route-loading-bar-actions">
          <span className="skeleton-line skeleton-chip" />
          <span className="skeleton-line skeleton-action" />
        </span>
      </div>
      <span className="skeleton-line skeleton-strip" aria-hidden="true" />
      <div className="route-loading-grid">
        <span className="skeleton-block" />
        <span className="skeleton-block" />
        <span className="skeleton-block" />
      </div>
      <span className="skeleton-panel" />
      <span className="sr-only" role="status" aria-live="polite">
        Carregando dados da página.
      </span>
    </section>
  );
}
