import { BackofficeHome } from "../../../components/backoffice-home";

/**
 * Student-edition backoffice home (F6.1). Billing / PalmUP multi-tenant
 * operations surfaces were removed from navigation; this page only links
 * student-relevant areas (clients, webhooks, read-only license).
 */
export default function BackofficePage() {
  return <BackofficeHome />;
}
