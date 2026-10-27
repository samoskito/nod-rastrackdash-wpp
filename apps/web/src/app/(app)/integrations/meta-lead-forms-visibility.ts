/**
 * Formulários Meta (Lead Ads) ficam ocultos até serem validados (decisão do
 * Samuel, 27/10/2026). Só `true`/`1`/`on`/`yes` em
 * WPPTRACK_WEB_META_LEAD_FORMS_ENABLED mostra o card; a API, o banco e o
 * webhook continuam como estão.
 */
export function metaLeadFormsVisible(
  value = process.env.WPPTRACK_WEB_META_LEAD_FORMS_ENABLED,
): boolean {
  return ["true", "1", "on", "yes"].includes(
    (value ?? "").trim().toLowerCase(),
  );
}
