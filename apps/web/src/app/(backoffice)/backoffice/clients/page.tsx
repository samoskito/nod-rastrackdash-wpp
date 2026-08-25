import {
  Database,
  Info,
  ShieldCheck,
  Terminal,
  UserCog,
  UsersRound,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { BackofficeNavigation } from "../../../../components/backoffice-navigation";

/**
 * Student-edition "Clientes e acessos".
 *
 * The PalmUP platform build backs this route with `backoffice/workspaces`,
 * `backoffice/platform-users` and `backoffice/external-data/connectors`. None
 * of those controllers ship in this public template, so there is no honest way
 * to list client records or expose action forms here. Rather than 404 (the
 * sidebar, the backoffice home and the platform-admin login all point here) or
 * redirect away and hide the gap, this page states plainly what is missing and
 * routes the student to the surfaces that do exist. No KPIs, no counters, no
 * placeholder rows.
 */

const missingAreas: Array<{
  description: string;
  icon: LucideIcon;
  label: string;
}> = [
  {
    description:
      "Criar, renomear e listar os workspaces de todos os clientes em um só lugar.",
    icon: UsersRound,
    label: "Painel de workspaces",
  },
  {
    description:
      "Gerenciar contas de operadores da plataforma e seus papéis internos.",
    icon: UserCog,
    label: "Equipe da plataforma",
  },
  {
    description:
      "Cadastrar e monitorar conectores de dados externos (MySQL) por cliente.",
    icon: Database,
    label: "Conectores externos",
  },
];

const availableAreas: Array<{
  description: string;
  href: string;
  icon: LucideIcon;
  label: string;
}> = [
  {
    description:
      "Convide operadores, ajuste papéis e revogue acessos do workspace em que você está.",
    href: "/settings",
    icon: UserCog,
    label: "Equipe do workspace atual",
  },
  {
    description:
      "Conecte a Meta e o provedor de WhatsApp do cliente e configure o roteamento.",
    href: "/integrations",
    icon: Webhook,
    label: "Integrações do workspace",
  },
  {
    description:
      "Acompanhe as conexões de webhook do workspace atual em modo somente leitura.",
    href: "/backoffice/inbound-webhooks",
    icon: Webhook,
    label: "Webhooks WhatsApp",
  },
  {
    description:
      "Confira o status da licença local desta instância (somente leitura).",
    href: "/backoffice/license",
    icon: ShieldCheck,
    label: "Licença",
  },
];

export default function BackofficeClientsPage() {
  return (
    <section className="page-stack standalone-page client-admin-page">
      <BackofficeNavigation active="clients" />

      <header className="page-header">
        <div>
          <span className="eyebrow">Operação da plataforma</span>
          <h1>Clientes e acessos</h1>
          <p>
            Gestão multi-cliente não faz parte desta edição do template. Veja
            abaixo o que está fora e por onde seguir.
          </p>
        </div>
        <span className="status-chip neutral">
          <Info aria-hidden="true" size={14} strokeWidth={2} />
          Não incluído nesta edição
        </span>
      </header>

      <section className="surface-panel client-management-disclosure" role="note">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">Por que esta página está vazia</span>
            <h2>Sem backend multi-cliente neste template</h2>
            <p>
              Esta instância student não expõe os endpoints de administração de
              clientes da plataforma PalmUP. Sem eles, qualquer lista de
              workspaces, equipe ou conector aqui seria inventada — então ela
              não é exibida.
            </p>
          </div>
        </div>

        <ul className="inbound-readiness-blockers">
          {missingAreas.map((area) => {
            const Icon = area.icon;

            return (
              <li key={area.label}>
                <Icon aria-hidden="true" size={16} strokeWidth={2} />{" "}
                <strong>{area.label}</strong> — {area.description}
              </li>
            );
          })}
        </ul>
      </section>

      <section className="surface-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">Como criar um cliente aqui</span>
            <h2>Primeiro workspace pela linha de comando</h2>
            <p>
              Nesta edição, o workspace de um cliente é criado junto com o
              usuário responsável, pelo script da API. Rode no servidor da API,
              nunca com segredos no chat.
            </p>
          </div>
          <span className="status-chip neutral">
            <Terminal aria-hidden="true" size={14} strokeWidth={2} />
            CLI da API
          </span>
        </div>

        <pre className="inbound-raw-payload">
          <code>
            pnpm --filter @wpptrack/api create-user -- --email
            responsavel@cliente.com --password &quot;senha-forte&quot; --name
            &quot;Nome&quot; --workspace &quot;Cliente&quot;
          </code>
        </pre>

        <p className="muted">
          O passo a passo completo está em <code>docs/GUIA-ALUNO.md</code>. Com a
          licença inativa a API responde <code>423</code> nas escritas — ative
          antes em <a href="/backoffice/license">Licença</a>.
        </p>
      </section>

      <section className="surface-panel">
        <div className="section-heading-row">
          <div>
            <span className="eyebrow">Áreas disponíveis</span>
            <h2>Para onde ir a partir daqui</h2>
          </div>
        </div>

        <div className="backoffice-command-list">
          {availableAreas.map((area) => {
            const Icon = area.icon;

            return (
              <a
                className="backoffice-command-row"
                href={area.href}
                key={area.href}
              >
                <span className="backoffice-command-icon" aria-hidden="true">
                  <Icon size={20} strokeWidth={2} />
                </span>
                <span className="backoffice-command-copy">
                  <strong>{area.label}</strong>
                  <span>{area.description}</span>
                </span>
              </a>
            );
          })}
        </div>
      </section>
    </section>
  );
}
