import type { ReactNode } from "react";
import { HelpTip } from "./help-tip";

/**
 * Compact top row of a page: a short title, the page help behind an "i",
 * and the page's chips or actions on the same line. It replaces the old
 * eyebrow + big title + paragraph header, so the data starts right under
 * the support/data bars (the menu already says which page this is).
 */
export function PageBar({
  title,
  titleId,
  help,
  helpLabel,
  children,
  className,
}: {
  title: ReactNode;
  titleId?: string;
  /** Explanation that used to be the header paragraph. */
  help?: ReactNode;
  helpLabel?: string;
  /** Chips, filters or actions shown on the same row, aligned right. */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <header className={`page-bar${className ? ` ${className}` : ""}`}>
      <div className="page-bar-title">
        <h1 id={titleId}>{title}</h1>
        {help ? (
          <HelpTip label={helpLabel ?? "Sobre esta página"}>{help}</HelpTip>
        ) : null}
      </div>
      {children ? <div className="page-bar-actions">{children}</div> : null}
    </header>
  );
}
