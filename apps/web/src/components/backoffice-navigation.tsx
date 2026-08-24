import {
  Home,
  ShieldCheck,
  UsersRound,
  Webhook,
  type LucideIcon,
} from "lucide-react";

export type BackofficeArea = "clients" | "home" | "license" | "webhooks";

type BackofficeNavigationProps = {
  active: BackofficeArea;
};

const items: Array<{
  area: BackofficeArea;
  href: string;
  icon: LucideIcon;
  label: string;
  shortLabel: string;
}> = [
  {
    area: "home",
    href: "/backoffice",
    icon: Home,
    label: "Inicio",
    shortLabel: "Inicio",
  },
  {
    area: "clients",
    href: "/backoffice/clients",
    icon: UsersRound,
    label: "Clientes",
    shortLabel: "Clientes",
  },
  {
    area: "webhooks",
    href: "/backoffice/inbound-webhooks",
    icon: Webhook,
    label: "Webhooks WhatsApp",
    shortLabel: "Webhooks",
  },
  {
    area: "license",
    href: "/backoffice/license",
    icon: ShieldCheck,
    label: "Licença",
    shortLabel: "Licença",
  },
];

export function BackofficeNavigation({ active }: BackofficeNavigationProps) {
  return (
    <nav className="backoffice-navigation" aria-label="Areas do backoffice">
      {items.map((item) => {
        const Icon = item.icon;
        const isActive = item.area === active;

        return (
          <a
            className={`backoffice-navigation-link${isActive ? " active" : ""}`}
            href={item.href}
            aria-current={isActive ? "page" : undefined}
            key={item.area}
          >
            <Icon aria-hidden="true" size={16} strokeWidth={2} />
            <span className="backoffice-navigation-label-long">
              {item.label}
            </span>
            <span className="backoffice-navigation-label-short">
              {item.shortLabel}
            </span>
          </a>
        );
      })}
    </nav>
  );
}
