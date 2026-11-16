'use client';

import { useState } from 'react';
import { SearchLimits } from '@caseflow/schemas';
import { CloseIcon, Icon } from '../../ui/icon';
import { Spinner } from '../../ui/spinner';
import styles from './search.module.css';

/**
 * Search input that only searches on Enter or the Search button, so typing never sends requests.
 * `value` is the active search; the field keeps its own draft until submitted. `busy` shows that a
 * submitted search is still loading; the button stays enabled so a corrected search can replace it.
 */
export function SearchField({
  label,
  value,
  placeholder,
  size = 'md',
  busy = false,
  onSearch,
}: {
  label: string;
  value: string;
  placeholder: string;
  size?: 'md' | 'lg';
  busy?: boolean;
  onSearch: (query: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const [active, setActive] = useState(value);
  // Follow external changes to the active search (e.g. back/forward navigation).
  if (value !== active) {
    setActive(value);
    setDraft(value);
  }

  return (
    <form
      role="search"
      className={`${styles.field} ${size === 'lg' ? styles.large : ''}`}
      onSubmit={(event) => {
        event.preventDefault();
        onSearch(draft.trim());
      }}
    >
      <div className={styles.inputWrap}>
        <span className={styles.fieldIcon} aria-hidden="true">
          <Icon size={size === 'lg' ? 20 : 16}>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </Icon>
        </span>
        <input
          className={styles.input}
          type="search"
          aria-label={label}
          value={draft}
          placeholder={placeholder}
          maxLength={SearchLimits.QueryMaxLength}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
        />
        {draft && (
          <button
            type="button"
            className={styles.clear}
            aria-label="Clear search"
            onClick={() => {
              setDraft('');
              if (value) {
                onSearch('');
              }
            }}
          >
            <CloseIcon />
          </button>
        )}
      </div>
      <button type="submit" className={styles.submit} aria-busy={busy}>
        {busy ? (
          <>
            <Spinner size={size === 'lg' ? 18 : 14} />
            Searching…
          </>
        ) : (
          'Search'
        )}
      </button>
    </form>
  );
}
