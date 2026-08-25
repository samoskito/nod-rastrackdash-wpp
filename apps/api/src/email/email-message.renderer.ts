import { Injectable } from "@nestjs/common";
import { EmailConfigurationService } from "./email-configuration.service";
import type {
  RenderedEmailMessage,
  TransactionalEmailEnvelope,
} from "./email.types";

type EmailBody = {
  preheader: string;
  heading: string;
  paragraphs: string[];
  /** Optional monospaced block (e.g. license key). Escaped on render. */
  codeBlock?: string;
  actionLabel: string;
  actionUrl: string;
  footerNote: string;
};

@Injectable()
export class EmailMessageRenderer {
  constructor(private readonly configuration: EmailConfigurationService) {}

  render(envelope: TransactionalEmailEnvelope): RenderedEmailMessage {
    const smtp = this.configuration.getSmtpConfig();
    const rendered = this.renderTemplate(envelope);

    return {
      from: {
        name: smtp.fromName,
        address: smtp.fromAddress,
      },
      replyTo: smtp.replyTo,
      to: envelope.to,
      subject: rendered.subject,
      text: this.renderText(rendered.body),
      html: this.renderHtml(rendered.body),
    };
  }

  private renderTemplate(envelope: TransactionalEmailEnvelope): {
    subject: string;
    body: EmailBody;
  } {
    if (envelope.template === "workspace_invitation") {
      const workspaceName = envelope.data.workspaceName;
      const inviter = envelope.data.inviterName
        ? `${envelope.data.inviterName} convidou você`
        : "Você recebeu um convite";

      return {
        subject: `Convite para acessar ${workspaceName} no WppTrack`,
        body: {
          preheader: `Seu acesso ao workspace ${workspaceName} está pronto para ser ativado.`,
          heading: `Você foi convidado para ${workspaceName}`,
          paragraphs: [
            `${inviter} para participar deste workspace no WppTrack com o perfil ${envelope.data.roleLabel}.`,
            `Este convite expira em ${this.formatExpiry(envelope.data.expiresAt)}.`,
          ],
          actionLabel: "Aceitar convite",
          actionUrl: this.actionUrl("/invite/accept", envelope.data.token),
          footerNote:
            "Se você não esperava este convite, ignore esta mensagem ou fale com nosso suporte.",
        },
      };
    }

    if (envelope.template === "password_reset") {
      return {
        subject: "Redefina sua senha no WppTrack",
        body: {
          preheader: "Use este link protegido para criar uma nova senha.",
          heading: this.personalizedHeading(
            envelope.data.recipientName,
            "Vamos redefinir sua senha",
          ),
          paragraphs: [
            "Recebemos uma solicitação para redefinir a senha da sua conta.",
            `O link expira em ${this.formatExpiry(envelope.data.expiresAt)} e só pode ser usado uma vez.`,
          ],
          actionLabel: "Criar nova senha",
          actionUrl: this.actionUrl("/login/reset", envelope.data.token),
          footerNote:
            "Se você não solicitou a alteração, ignore esta mensagem. Sua senha continuará a mesma.",
        },
      };
    }

    if (envelope.template === "client_owner_activation") {
      return {
        subject: `Crie seu acesso a ${envelope.data.workspaceName} no WppTrack`,
        body: {
          preheader: `Seu acesso ao workspace ${envelope.data.workspaceName} esta pronto para ser ativado.`,
          heading: this.personalizedHeading(
            envelope.data.recipientName,
            "Crie sua senha de acesso",
          ),
          paragraphs: [
            `Voce foi definido como responsavel pelo workspace ${envelope.data.workspaceName}.`,
            `Seu login e ${envelope.to.address}. Por seguranca, nenhuma senha foi criada ou enviada pela plataforma.`,
            `Este link expira em ${this.formatExpiry(envelope.data.expiresAt)} e so pode ser usado uma vez.`,
          ],
          actionLabel: "Criar senha e acessar",
          actionUrl: this.actionUrl("/login/activate", envelope.data.token),
          footerNote:
            "Se voce nao esperava este acesso, ignore esta mensagem ou fale com nosso suporte.",
        },
      };
    }

    if (envelope.template === "workspace_access_granted") {
      return {
        subject: `Novo workspace disponivel no WppTrack: ${envelope.data.workspaceName}`,
        body: {
          preheader: `O workspace ${envelope.data.workspaceName} foi adicionado a sua conta.`,
          heading: this.personalizedHeading(
            envelope.data.recipientName,
            "um novo workspace esta disponivel",
          ),
          paragraphs: [
            `O workspace ${envelope.data.workspaceName} foi adicionado a sua conta WppTrack.`,
            `Entre com ${envelope.to.address} e a senha que voce ja utiliza. Suas credenciais nao foram alteradas.`,
          ],
          actionLabel: "Entrar no WppTrack",
          actionUrl: this.loginUrl(),
          footerNote:
            "Se voce nao reconhece este acesso, entre em contato com nosso suporte.",
        },
      };
    }

    if (envelope.template === "platform_operator_activation") {
      return {
        subject: "Ative seu acesso de operador da plataforma WppTrack",
        body: {
          preheader: "Seu acesso de operador esta pronto para ser ativado.",
          heading: this.personalizedHeading(
            envelope.data.recipientName,
            "Ative seu acesso de operador",
          ),
          paragraphs: [
            "Voce recebeu acesso operacional ao backoffice da plataforma WppTrack.",
            `Este link expira em ${this.formatExpiry(envelope.data.expiresAt)} e so pode ser usado uma vez.`,
            "Crie sua senha pelo link. Nenhuma senha foi criada ou enviada pela plataforma.",
          ],
          actionLabel: "Criar senha e acessar",
          actionUrl: this.actionUrl("/login/activate", envelope.data.token),
          footerNote:
            "Se voce nao esperava este acesso, ignore esta mensagem e fale com o proprietario da plataforma.",
        },
      };
    }

    if (envelope.template === "license_key_delivery") {
      const productName = envelope.data.productName;
      const support =
        envelope.data.supportEmail?.trim() || "suporte@rastrack.app";
      return {
        subject: `Sua chave ${productName}`,
        body: {
          preheader: `Sua chave de acesso ${productName} chegou. Guarde com segurança.`,
          heading: this.personalizedHeading(
            envelope.data.recipientName,
            "sua chave de acesso chegou",
          ),
          paragraphs: [
            `Segue a chave do ${productName}. Ela libera o template e o onboarding do seu ambiente.`,
            `Validade até ${this.formatExpiry(envelope.data.expiresAt)} (prefixo de suporte: ${envelope.data.keyPrefix}).`,
            "Clone o repositório, cole a chave quando o setup pedir e use um assistente de IA (Claude/Codex/Grok) com o AGENTS.md do projeto para configurar.",
            `Dúvidas: ${support}.`,
          ],
          codeBlock: envelope.data.licenseKey,
          actionLabel: "Abrir repositório",
          actionUrl: envelope.data.repoUrl,
          footerNote:
            "Não compartilhe esta chave. Ela fica vinculada à primeira conta que ativar (1 licença = 1 conta).",
        },
      };
    }

    return {
      subject: "Confirme seu e-mail no WppTrack",
      body: {
        preheader: "Confirme seu endereço de e-mail para proteger sua conta.",
        heading: this.personalizedHeading(
          envelope.data.recipientName,
          "Confirme seu e-mail",
        ),
        paragraphs: [
          "Só falta confirmar que este endereço de e-mail pertence a você.",
          `O link expira em ${this.formatExpiry(envelope.data.expiresAt)} e só pode ser usado uma vez.`,
        ],
        actionLabel: "Confirmar e-mail",
        actionUrl: this.actionUrl("/login/verify", envelope.data.token),
        footerNote:
          "Se você não reconhece esta conta, ignore esta mensagem ou entre em contato com nosso suporte.",
      },
    };
  }

  private renderText(body: EmailBody): string {
    return [
      "WppTrack",
      "",
      body.heading,
      "",
      ...body.paragraphs.flatMap((paragraph) => [paragraph, ""]),
      ...(body.codeBlock ? ["Sua chave:", body.codeBlock, ""] : []),
      `${body.actionLabel}: ${body.actionUrl}`,
      "",
      body.footerNote,
      "",
      "Suporte: suporte@rastrack.app",
    ].join("\n");
  }

  private renderHtml(body: EmailBody): string {
    const paragraphs = body.paragraphs
      .map(
        (paragraph) =>
          `<p style="margin:0 0 16px;color:#334155;font-size:16px;line-height:1.65;">${this.escapeHtml(paragraph)}</p>`,
      )
      .join("");
    const codeBlock = body.codeBlock
      ? `<pre style="margin:0 0 20px;padding:14px 16px;background:#0f2926;color:#ecfdf5;border-radius:6px;font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-size:15px;line-height:1.5;letter-spacing:0.04em;overflow-x:auto;">${this.escapeHtml(body.codeBlock)}</pre>`
      : "";

    return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="x-apple-disable-message-reformatting">
  <title>${this.escapeHtml(body.heading)}</title>
  <style>@media (max-width:620px){.email-shell{width:100%!important}.email-content{padding:28px 22px!important}.email-action{display:block!important;text-align:center!important}}</style>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${this.escapeHtml(body.preheader)}</div>
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f5f9;">
    <tr>
      <td align="center" style="padding:32px 12px;">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" class="email-shell" style="width:600px;max-width:600px;background:#ffffff;border:1px solid #dbe5e3;border-radius:8px;overflow:hidden;">
          <tr><td style="padding:22px 32px;background:#0f2926;color:#ffffff;font-size:20px;font-weight:700;">WppTrack</td></tr>
          <tr>
            <td class="email-content" style="padding:40px 40px 32px;">
              <h1 style="margin:0 0 20px;color:#102a27;font-size:26px;line-height:1.25;letter-spacing:0;">${this.escapeHtml(body.heading)}</h1>
              ${paragraphs}
              ${codeBlock}
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0;">
                <tr><td bgcolor="#0e8c7a" style="border-radius:6px;"><a class="email-action" href="${this.escapeHtml(body.actionUrl)}" style="display:inline-block;padding:14px 22px;color:#ffffff;text-decoration:none;font-size:16px;font-weight:700;">${this.escapeHtml(body.actionLabel)}</a></td></tr>
              </table>
              <p style="margin:0;color:#64748b;font-size:14px;line-height:1.6;">${this.escapeHtml(body.footerNote)}</p>
            </td>
          </tr>
          <tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;color:#64748b;font-size:13px;line-height:1.5;">Precisa de ajuda? Responda este e-mail ou escreva para <a href="mailto:suporte@rastrack.app" style="color:#0e8c7a;">suporte@rastrack.app</a>.</td></tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private personalizedHeading(
    name: string | undefined,
    fallback: string,
  ): string {
    return name ? `${name}, ${fallback.toLowerCase()}` : fallback;
  }

  private actionUrl(path: string, token: string): string {
    const url = new URL(path, `${this.configuration.getWebOrigin()}/`);
    url.searchParams.set("token", token);
    return url.toString();
  }

  private loginUrl(): string {
    return new URL(
      "/login",
      `${this.configuration.getWebOrigin()}/`,
    ).toString();
  }

  private formatExpiry(value: string): string {
    return new Intl.DateTimeFormat("pt-BR", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "America/Sao_Paulo",
    }).format(new Date(value));
  }

  private escapeHtml(value: string): string {
    return value.replace(/[&<>'"]/g, (character) => {
      const escaped: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      };

      return escaped[character] ?? character;
    });
  }
}
