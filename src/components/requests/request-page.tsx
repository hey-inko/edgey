import type { ReactNode } from "react";
import styles from "./request.module.css";

export function RequestPage({
  overline,
  title,
  intro,
  children,
}: {
  overline: string;
  title: string;
  intro: ReactNode;
  children: ReactNode;
}) {
  return (
    <main id="main-content" tabIndex={-1} className="frame simple-page">
      <header className={styles.pageHeader}>
        <p className="kicker">
          <span className="register" aria-hidden="true" />
          {overline}
        </p>
        <h1>{title}</h1>
        <p className="muted">{intro}</p>
      </header>
      {children}
    </main>
  );
}
