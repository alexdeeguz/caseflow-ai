'use client';

import { useId, useRef, useState } from 'react';
import { DocumentLimits } from '@caseflow/schemas';
import { validateFile, documentAccept } from '../../../lib/documents/file-validation';
import type { UploadCase } from '../../../lib/documents/upload-types';
import { formatFileSize } from '../../../lib/documents/presentation';
import { Button } from '../../ui/button';
import { DocumentIcon } from './document-icon';
import { useUploads } from './upload-provider';
import styles from './uploads.module.css';

interface Selection {
  id: string;
  file: File;
  error: string | null;
}

export function UploadPanel({ target, onClose }: { target: UploadCase; onClose: () => void }) {
  const { store } = useUploads();
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const id = useId();
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

  function upload() {
    try {
      store.add(
        selected.map(({ file }) => file),
        target,
      );
      setSelected([]);
      onClose();
    } catch (issue) {
      setError(issue instanceof Error ? issue.message : 'Unable to queue these files.');
      heading.current?.focus();
    }
  }

  return (
    <section className={styles.panel} aria-labelledby={`${id}-title`}>
      <div className={styles.panelHeader}>
        <div>
          <h3 id={`${id}-title`} ref={heading} tabIndex={-1}>
            Upload documents
          </h3>
          <p>PDF, JPEG, or PNG · Up to 25 MiB each · 10 files per batch</p>
        </div>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>
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
          <DocumentIcon />
        </span>
        <strong>Drop your files here</strong>
        <span>or choose files from your device</span>
        <input
          ref={input}
          id={`${id}-files`}
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
        <Button variant="secondary" onClick={() => input.current?.click()}>
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
      <div className={styles.panelFooter}>
        <p>Use fictional data only. Files appear in the library after verification.</p>
        <Button disabled={!selected.length || selected.some((item) => item.error)} onClick={upload}>
          Upload
          {selected.length
            ? ` ${selected.length} ${selected.length === 1 ? 'file' : 'files'}`
            : ' files'}
        </Button>
      </div>
    </section>
  );
}
