import { redirect } from "next/navigation";

/**
 * PalmUP billing was removed from the student edition (F6.1). Deep links
 * to /backoffice/billing land here and bounce to the backoffice home so
 * they never 404 or re-surface Assinaturas UI.
 */
export default function BackofficeBillingRedirectPage() {
  redirect("/backoffice");
}
