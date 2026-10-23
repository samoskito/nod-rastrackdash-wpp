export default function ProductRouteLoading() {
  return (
    <section
      className="page-stack route-loading"
      aria-busy="true"
      aria-label="Carregando página"
    >
      <header className="page-header route-loading-header">
        <div>
          <span className="skeleton-line skeleton-eyebrow" />
          <span className="skeleton-line skeleton-title" />
          <span className="skeleton-line skeleton-copy" />
        </div>
        <span className="skeleton-line skeleton-action" />
      </header>
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
