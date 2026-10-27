import { BookOpenCheck, Inbox, Webhook } from "lucide-react";

/**
 * Abas da área "Webhooks" do Backoffice (fase 6.5): conexões WhatsApp,
 * Recebimentos das URLs únicas (porte do SaaS #170) e Leitores de webhook
 * (diagnóstico só de leitura). Tudo leitura.
 */
export type WebhooksView = "connections" | "integration-events" | "parsers";

const views: Array<{
  view: WebhooksView;
  href: string;
  label: string;
  Icon: typeof Webhook;
}> = [
  {
    view: "connections",
    href: "/backoffice/inbound-webhooks",
    label: "Conexões WhatsApp",
    Icon: Webhook,
  },
  {
    view: "integration-events",
    href: "/backoffice/inbound-webhooks/integration-events",
    label: "Recebimentos das URLs únicas",
    Icon: Inbox,
  },
  {
    view: "parsers",
    href: "/backoffice/inbound-webhooks/parsers",
    label: "Leitores de webhook",
    Icon: BookOpenCheck,
  },
];

export function WebhooksViewSwitch({ active }: { active: WebhooksView }) {
  return (
    <nav className="conversion-trace-view-switch" aria-label="Área de webhooks">
      {views.map(({ view, href, label, Icon }) => (
        <a
          key={view}
          className={view === active ? "active" : undefined}
          href={href}
          aria-current={view === active ? "page" : undefined}
        >
          <Icon aria-hidden="true" size={17} strokeWidth={2} />
          {label}
        </a>
      ))}
    </nav>
  );
}
