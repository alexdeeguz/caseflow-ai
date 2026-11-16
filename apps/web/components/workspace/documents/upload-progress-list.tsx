'use client';

import {
  UploadPhase,
  UploadRetry,
  isUploadRunning,
  uploadPhaseLabels,
  type UploadItem,
} from '../../../lib/documents/upload-types';
import type { UploadQueue } from '../../../lib/documents/upload-queue';
import { formatFileSize } from '../../../lib/documents/presentation';
import { DocumentIcon } from './document-icon';
import styles from './uploads.module.css';

/** Per-file upload status with progress and the actions each state allows. */
export function UploadProgressList({
  items,
  store,
}: {
  items: readonly UploadItem[];
  store: UploadQueue;
}) {
  return (
    <ul className={styles.progressList} aria-label="Upload progress">
      {items.map((item) => {
        const running = isUploadRunning(item.phase);
        const canRetry =
          (item.phase === UploadPhase.Failed || item.phase === UploadPhase.Stopped) &&
          item.retry !== UploadRetry.None;

        return (
          <li key={item.id} data-phase={item.phase}>
            <span className={styles.fileIcon}>
              <DocumentIcon />
            </span>
            <div className={styles.fileInfo}>
              <strong>{item.filename}</strong>
              <span>
                {formatFileSize(item.sizeBytes)} ·{' '}
                <span
                  className={
                    item.phase === UploadPhase.Uploaded
                      ? styles.success
                      : item.phase === UploadPhase.Failed || item.phase === UploadPhase.Stopped
                        ? styles.error
                        : styles.stage
                  }
                  role="status"
                >
                  {uploadPhaseLabels[item.phase]}
                  {item.phase === UploadPhase.Verifying ? ': checking file integrity' : ''}
                </span>
              </span>
              {(item.phase === UploadPhase.Uploading || item.phase === UploadPhase.Verifying) && (
                <div className={styles.progressRow}>
                  <progress
                    max={100}
                    value={item.phase === UploadPhase.Verifying ? 100 : item.progress}
                    aria-label={`Transfer progress for ${item.filename}`}
                  />
                  <span aria-hidden="true">
                    {item.phase === UploadPhase.Verifying ? 100 : item.progress}%
                  </span>
                </div>
              )}
              {item.error && <span className={styles.error}>{item.error}</span>}
            </div>
            <div className={styles.itemActions}>
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
                  Stop<span className="sr-only"> uploading {item.filename}</span>
                </button>
              )}
              {!running && item.phase !== UploadPhase.Uploaded && (
                <button
                  type="button"
                  className={styles.textButton}
                  onClick={() => store.dismiss(item.id)}
                >
                  Remove<span className="sr-only"> {item.filename}</span>
                </button>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
