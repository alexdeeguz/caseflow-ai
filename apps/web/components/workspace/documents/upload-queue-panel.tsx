'use client';

import { useId, useState } from 'react';
import {
  UploadPhase,
  UploadRetry,
  uploadPhaseLabels,
  isUploadRunning,
} from '../../../lib/documents/upload-types';
import { formatFileSize } from '../../../lib/documents/presentation';
import { DocumentIcon } from './document-icon';
import { useUploads } from './upload-provider';
import styles from './uploads.module.css';

export function UploadQueuePanel() {
  const { store, items } = useUploads();
  const [open, setOpen] = useState(true);
  const id = useId();
  if (!items.length) {
    return null;
  }
  const active = items.filter(
    (item) => isUploadRunning(item.phase) || item.phase === UploadPhase.Queued,
  ).length;
  const done = items.filter((item) => item.phase === UploadPhase.Uploaded).length;
  const attention = items.filter(
    (item) => item.phase === UploadPhase.Failed || item.phase === UploadPhase.Stopped,
  ).length;

  return (
    <aside className={styles.queue} aria-label="Document uploads">
      <button
        type="button"
        className={styles.queueToggle}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.queueTitle}>
          <DocumentIcon />
          <strong>Uploads</strong>
        </span>
        <span>
          {active ? `${active} in progress` : `${done} uploaded`}
          {attention ? ` · ${attention} need attention` : ''}
        </span>
        <span>{open ? 'Hide' : 'Show'}</span>
      </button>
      <div id={id} hidden={!open}>
        <p className={styles.queueHint}>
          Uploads continue as you browse this workspace. Keep this tab open.
        </p>
        <ul className={styles.queueList}>
          {items.map((item) => {
            const running = isUploadRunning(item.phase);
            const canRetry =
              (item.phase === UploadPhase.Failed || item.phase === UploadPhase.Stopped) &&
              item.retry !== UploadRetry.None;
            return (
              <li key={item.id}>
                <div className={styles.fileInfo}>
                  <strong>{item.filename}</strong>
                  <span>
                    {item.case.label} · {formatFileSize(item.sizeBytes)}
                  </span>
                  <span
                    className={item.phase === UploadPhase.Uploaded ? styles.success : styles.stage}
                    role="status"
                  >
                    {uploadPhaseLabels[item.phase]}
                    {item.phase === UploadPhase.Verifying ? ' — checking file integrity' : ''}
                  </span>
                  {item.phase === UploadPhase.Uploading && (
                    <div className={styles.progressRow}>
                      <progress
                        max={100}
                        value={item.progress}
                        aria-label={`Transfer progress for ${item.filename}`}
                      />
                      <span aria-hidden="true">{item.progress}%</span>
                    </div>
                  )}
                  {item.error && <span className={styles.error}>{item.error}</span>}
                </div>
                <div className={styles.queueActions}>
                  {canRetry && (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => store.retry(item.id)}
                    >
                      {item.retry === UploadRetry.NewAttempt ? 'New attempt' : 'Retry'}
                      <span className="sr-only"> {item.filename}</span>
                    </button>
                  )}
                  {running && item.phase !== UploadPhase.Verifying && (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => store.stop(item.id)}
                    >
                      Stop upload<span className="sr-only"> for {item.filename}</span>
                    </button>
                  )}
                  {!running && (
                    <button
                      type="button"
                      className={styles.textButton}
                      onClick={() => store.dismiss(item.id)}
                    >
                      {item.phase === UploadPhase.Queued ? 'Remove' : 'Dismiss'}
                      <span className="sr-only"> {item.filename}</span>
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}
