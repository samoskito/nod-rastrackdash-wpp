import type { Metadata } from "next";
import type { CSSProperties, ReactNode } from "react";
import "../styles/globals.css";
import "../styles/layout-system.css";
import "../styles/crm.css";
import "../styles/glass.css";
import "../styles/density-reports.css";
import "../styles/density-pages.css";
import "../styles/density-overview.css";
import { defaultBrandConfig, getBrandConfig } from "../lib/brand";

const presentationModeBootstrap = `
  try {
    document.documentElement.dataset.presentationMode =
      window.localStorage.getItem("wpptrack-presentation-mode") === "true"
        ? "active"
        : "inactive";
  } catch {
    document.documentElement.dataset.presentationMode = "inactive";
  }
`;

export function generateMetadata(): Metadata {
  const brand = getBrandConfig();

  return {
    title: brand.name,
    description: `${brand.name} - cockpit de WhatsApp, tráfego e conversões para clientes finais.`,
    icons: {
      icon: brand.faviconUrl ?? "/favicon.svg",
    },
  };
}

export default function RootLayout({ children }: { children: ReactNode }) {
  const brand = getBrandConfig();
  const brandStyle = {
    "--brand-primary": brand.primaryColor,
    // Only a color the student chose repaints the glass primary buttons.
    ...(brand.primaryColor === defaultBrandConfig.primaryColor
      ? {}
      : { "--brand-accent": brand.primaryColor }),
  } as CSSProperties;

  return (
    <html lang="pt-BR" suppressHydrationWarning style={brandStyle}>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: presentationModeBootstrap }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
