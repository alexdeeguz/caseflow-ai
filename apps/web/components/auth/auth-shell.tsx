import type { ReactNode } from 'react';
import { Brand } from '../brand';
import styles from './auth-shell.module.css';

export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <a href="#main-content" className={styles.skip}>
        Skip to content
      </a>
      <header className={styles.header}>
        <Brand />
        <span className={styles.badge}>Portfolio demo</span>
      </header>
      <main id="main-content" className={styles.main} tabIndex={-1}>
        <section className={styles.intro} aria-labelledby="hero-title">
          <p className={styles.eyebrow}>
            <span /> THE CASEFLOW WORKSPACE
          </p>
          <h1 id="hero-title">
            Every detail.
            <br />
            <span>A clearer case.</span>
          </h1>
          <p className={styles.description}>
            A focused space for the work behind every case. Start with your Microsoft account.
          </p>
          <div className={styles.note}>
            <span className={styles.noteNumber}>01 /</span>
            <div>
              <p className={styles.noteTitle}>Your workspace starts here.</p>
              <p className={styles.noteBody}>Sign in. Verify your access. Keep moving.</p>
            </div>
          </div>
        </section>
        <div className={styles.cardColumn}>{children}</div>
      </main>
      <footer className={styles.footer}>
        <p>
          CaseFlow AI <span aria-hidden="true"> / </span> Independent portfolio project
        </p>
        <p>Demo environment · Fictional data only</p>
      </footer>
    </div>
  );
}
