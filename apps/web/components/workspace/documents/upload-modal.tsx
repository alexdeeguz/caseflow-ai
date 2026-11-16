'use client';

import { useRef, useState } from 'react';
import { DocumentLimits } from '@caseflow/schemas';
import { validateFile, documentAccept } from '../../../lib/documents/file-validation';
import type { UploadCase } from '../../../lib/documents/upload-types';
import { formatFileSize } from '../../../lib/documents/presentation';
import { Button } from '../../ui/button';
import { Modal } from '../../ui/overlay-dialog';
import { DocumentIcon } from './document-icon';
import { UploadIcon } from './document-icons';
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
  const { store } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<Selection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

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

  // Like the old inline panel, closing discards an unsent selection.
  function close() {
    setSelected([]);
    setError(null);
    setDragging(false);
    onClose();
  }

  function upload() {
    try {
      store.add(
        selected.map(({ file }) => file),
        target,
      );
      close();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Unable to queue these files.');
    }
  }

  return (
    <Modal
      open={open}
      title="Upload documents"
      description="PDF, JPEG, or PNG · Up to 25 MiB each · 10 files per batch"
      closeLabel="Close upload"
      onClose={close}
      footer={
        <>
          <p className={styles.footerHint}>
            Use fictional data only. Files appear in the library after verification.
          </p>
          <Button variant="secondary" className={styles.footerButton} onClick={close}>
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
      }
    >
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
                onClick={() => setSelected((current) => current.filter((item) => item.id !== id))}
                aria-label={`Remove ${file.name} from selection`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}
