import {
  Activity,
  CreditCard,
  LayoutDashboard,
  MessageCircle,
  type LucideIcon,
} from "lucide-react";

export type OperationsArea =
  | "finance"
  | "health"
  | "overview"
  | "whatsapp";

export type FinanceSection =
  | "charges"
  | "customers"
  | "plans"
  | "receivers";

export type HealthSection =
  | "audit"
  | "conversions"
  | "incidents"
  | "integrations"
  | "jobs"
  | "webhooks";

const areas: Array<{
  area: OperationsArea;
  href: string;
  icon: LucideIcon;
  label: string;
}> = [
  {
    area: "overview",
    href: "/backoffice?view=operations",
    icon: LayoutDashboard,
    label: "Visão geral",
  },
  {
    area: "whatsapp",
    href: "/backoffice?view=operations&area=whatsapp",
    icon: MessageCircle,
    label: "WhatsApp",
  },
  {
    area: "finance",
    href: "/backoffice?view=operations&area=finance&section=charges",
    icon: CreditCard,
    label: "Financeiro",
  },
  {
    area: "health",
    href: "/backoffice?view=operations&area=health&section=incidents",
    icon: Activity,
    label: "Saúde",
  },
];

const financeSections: Array<{
  section: FinanceSection;
  label: string;
}> = [
  { section: "charges", label: "Cobranças" },
  { section: "plans", label: "Planos" },
  { section: "customers", label: "Workspaces" },
  { section: "receivers", label: "Recebedores" },
];

const healthSections: Array<{
  section: HealthSection;
  label: string;
}> = [
  { section: "incidents", label: "Incidentes" },
  { section: "webhooks", label: "Webhooks" },
  { section: "conversions", label: "CAPI" },
  { section: "integrations", label: "Integrações" },
  { section: "jobs", label: "Jobs" },
  { section: "audit", label: "Auditoria" },
];

export function BackofficeOperationsNavigation({
  activeArea,
}: {
  activeArea: OperationsArea;
}) {
  return (
    <nav
      className="operations-area-navigation"
      aria-label="Áreas das operações internas"
    >
      {areas.map((item) => {
        const Icon = item.icon;
        const active = item.area === activeArea;

        return (
          <a
            className={`operations-area-link${active ? " active" : ""}`}
            href={item.href}
            aria-current={active ? "page" : undefined}
            key={item.area}
          >
            <Icon aria-hidden="true" size={17} strokeWidth={2} />
            <span>{item.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

export function FinanceOperationsNavigation({
  activeSection,
}: {
  activeSection: FinanceSection;
}) {
  return (
    <nav
      className="operations-subnavigation"
      aria-label="Áreas financeiras"
    >
      {financeSections.map((item) => {
        const active = item.section === activeSection;

        return (
          <a
            className={`operations-subnavigation-link${active ? " active" : ""}`}
            href={`/backoffice?view=operations&area=finance&section=${item.section}`}
            aria-current={active ? "page" : undefined}
            key={item.section}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}

export function HealthOperationsNavigation({
  activeSection,
}: {
  activeSection: HealthSection;
}) {
  return (
    <nav
      className="operations-subnavigation"
      aria-label="Camadas da saúde operacional"
    >
      {healthSections.map((item) => {
        const active = item.section === activeSection;

        return (
          <a
            className={`operations-subnavigation-link${active ? " active" : ""}`}
            href={`/backoffice?view=operations&area=health&section=${item.section}`}
            aria-current={active ? "page" : undefined}
            key={item.section}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
