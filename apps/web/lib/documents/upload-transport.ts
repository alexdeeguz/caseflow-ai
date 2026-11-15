import type { UploadTransport } from './upload-types';

export const browserUploadTransport: UploadTransport = {
  async checksum(file) {
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return btoa(String.fromCharCode(...new Uint8Array(digest)));
  },
  put(file, authorization, signal, onProgress) {
    return new Promise<void>((resolve, reject) => {
      signal.throwIfAborted();
      const xhr = new XMLHttpRequest();
      const abort = () => xhr.abort();
      const finish = (error?: Error) => {
        signal.removeEventListener('abort', abort);
        xhr.upload.onprogress = null;
        xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onabort = null;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      xhr.upload.onprogress = (event) => {
        if (event.lengthComputable) {
          onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
        }
      };
      xhr.onload = () =>
        finish(
          xhr.status >= 200 && xhr.status < 300
            ? undefined
            : new Error('The transfer could not be confirmed.'),
        );
      xhr.onerror = xhr.ontimeout = () => finish(new Error('The transfer could not be confirmed.'));
      xhr.onabort = () => finish(new DOMException('Upload stopped', 'AbortError'));
      xhr.open(authorization.method, authorization.url);
      xhr.withCredentials = false;
      xhr.timeout = 180000;
      for (const [name, value] of Object.entries(authorization.headers)) {
        xhr.setRequestHeader(name, value);
      }
      signal.addEventListener('abort', abort, { once: true });
      xhr.send(file);
    });
  },
};
