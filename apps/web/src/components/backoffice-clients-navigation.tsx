import { Database, UserCog, UsersRound, type LucideIcon } from "lucide-react";

export type BackofficeClientsSection = "connectors" | "team" | "workspaces";

const sections: Array<{
  description: string;
  href: string;
  icon: LucideIcon;
  label: string;
  section: BackofficeClientsSection;
}> = [
  {
    description: "Ambientes e responsáveis",
    href: "/backoffice/clients?section=workspaces",
    icon: UsersRound,
    label: "Workspaces",
    section: "workspaces",
  },
  {
    description: "Acessos da plataforma",
    href: "/backoffice/clients?section=team",
    icon: UserCog,
    label: "Equipe interna",
    section: "team",
  },
  {
    description: "Fontes externas",
    href: "/backoffice/clients?section=connectors",
    icon: Database,
    label: "Conectores MySQL",
    section: "connectors",
  },
];

export function BackofficeClientsNavigation({
  activeSection,
}: {
  activeSection: BackofficeClientsSection;
}) {
  return (
    <nav
      className="client-area-navigation"
      aria-label="Áreas de clientes e acessos"
    >
      {sections.map((item) => {
        const Icon = item.icon;
        const active = item.section === activeSection;

        return (
          <a
            className={`client-area-link${active ? " active" : ""}`}
            href={item.href}
            aria-current={active ? "page" : undefined}
            key={item.section}
          >
            <Icon aria-hidden="true" size={18} strokeWidth={2} />
            <span>
              <strong>{item.label}</strong>
              <small>{item.description}</small>
            </span>
          </a>
        );
      })}
    </nav>
  );
}
