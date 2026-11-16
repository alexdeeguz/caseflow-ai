'use client';

import { useEffect, useRef, useState } from 'react';
import { DocumentLimits } from '@caseflow/schemas';
import { validateFile, documentAccept } from '../../../lib/documents/file-validation';
import {
  UploadPhase,
  isUploadRunning,
  overallUploadProgress,
  type UploadCase,
} from '../../../lib/documents/upload-types';
import { formatFileSize } from '../../../lib/documents/presentation';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/overlay-dialog';
import { DocumentIcon } from './document-icon';
import { UploadIcon } from './document-icons';
import { UploadProgressList } from './upload-progress-list';
import { useUploads } from './upload-provider';
import styles from './uploads.module.css';

interface Selection {
  id: string;
  file: File;
  error: string | null;
}

export function UploadModal({
  open,
  target,
  onClose,
}: {
  open: boolean;
  target: UploadCase;
  onClose: () => void;
}) {
  const { store, items } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // The batch started from this modal; the modal closes itself once that batch is verified.
  const [batch, setBatch] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      // Closing discards an unsent selection; queued uploads keep going in the background.
      setSelected([]);
      setError(null);
      setDragging(false);
      setBatch(null);
    }
  }

  // Uploads for this case (in progress, failed, or just finished) take over the modal.
  const uploads = items.filter((item) => item.case.id === target.id);
  const uploading = uploads.some(
    (item) => isUploadRunning(item.phase) || item.phase === UploadPhase.Queued,
  );
  const verified = uploads.filter((item) => item.phase === UploadPhase.Uploaded).length;
  const batchFinished =
    batch !== null &&
    !items.some((item) => item.batchId === batch && item.phase !== UploadPhase.Uploaded);

  useEffect(() => {
    if (open && batchFinished) {
      onClose();
    }
  }, [open, batchFinished, onClose]);

  function select(files: File[]) {
    if (selected.length + files.length > DocumentLimits.FilesPerBatch) {
      setError('Select up to 10 files at a time. Remove a selected file to make room.');
      return;
    }
    setError(null);
    setSelected((current) => [
      ...current,
      ...files.map((file) => {
        let error = null;
        try {
          validateFile(file);
        } catch (issue) {
          error = issue instanceof Error ? issue.message : 'This file is not supported.';
        }
        return { id: crypto.randomUUID(), file, error };
      }),
    ]);
  }

  function upload() {
    try {
      setBatch(
        store.add(
          selected.map(({ file }) => file),
          target,
        ),
      );
      setSelected([]);
      setError(null);
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Unable to queue these files.');
    }
  }

  const progressView = uploads.length > 0;
  const progress = overallUploadProgress(uploads);

  // One Modal for both views, so starting an upload swaps its content without reopening it.
  return (
    <Modal
      open={open}
      title={
        !progressView ? 'Upload documents' : uploading ? 'Uploading documents' : 'Upload finished'
      }
      description={
        progressView
          ? `${verified} of ${uploads.length} ${uploads.length === 1 ? 'file' : 'files'} uploaded and verified`
          : 'PDF, JPEG, or PNG · Up to 25 MiB each · 10 files per batch'
      }
      closeLabel={progressView && uploading ? 'Hide uploads' : 'Close upload'}
      onClose={onClose}
      footer={
        progressView ? (
          <>
            <p className={styles.footerHint}>
              {uploading
                ? 'Uploads continue if you hide this window. Keep this tab open.'
                : 'Retry files that need attention, or remove them.'}
            </p>
            <Button variant="secondary" className={styles.footerButton} onClick={onClose}>
              {uploading ? 'Hide' : 'Done'}
            </Button>
          </>
        ) : (
          <>
            <p className={styles.footerHint}>
              Use fictional data only. Files appear in the library after verification.
            </p>
            <Button variant="secondary" className={styles.footerButton} onClick={onClose}>
              Cancel
            </Button>
            <Button
              className={styles.footerButton}
              disabled={!selected.length || selected.some((item) => item.error)}
              onClick={upload}
            >
              Upload
              {selected.length
                ? ` ${selected.length} ${selected.length === 1 ? 'file' : 'files'}`
                : ' files'}
            </Button>
          </>
        )
      }
    >
      {progressView ? (
        <>
          <div className={styles.overall}>
            <div className={styles.progressRow}>
              <progress max={100} value={progress} aria-label="Overall upload progress" />
              <span aria-hidden="true">{progress}%</span>
            </div>
          </div>
          <UploadProgressList items={uploads} store={store} />
        </>
      ) : (
        <>
          <div
            className={`${styles.dropzone} ${dragging ? styles.dragging : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              select(Array.from(event.dataTransfer.files));
            }}
          >
            <span className={styles.dropIcon}>
              <UploadIcon size={22} />
            </span>
            <strong>Drop your files here</strong>
            <span>or choose files from your device</span>
            <input
              ref={input}
              type="file"
              multiple
              accept={documentAccept}
              className="sr-only"
              tabIndex={-1}
              aria-label="Choose documents to upload"
              onChange={(event) => {
                select(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <Button
              variant="secondary"
              className={styles.footerButton}
              onClick={() => input.current?.click()}
            >
              Choose files
            </Button>
          </div>
          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
          {!!selected.length && (
            <ul className={styles.selection} aria-label="Selected files">
              {selected.map(({ id, file, error }) => (
                <li key={id}>
                  <span className={styles.fileIcon}>
                    <DocumentIcon />
                  </span>
                  <div className={styles.fileInfo}>
                    <strong>{file.name}</strong>
                    <span>{formatFileSize(file.size)}</span>
                    {error && <span className={styles.error}>{error}</span>}
                  </div>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() =>
                      setSelected((current) => current.filter((item) => item.id !== id))
                    }
                    aria-label={`Remove ${file.name} from selection`}
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </Modal>
  );
}
