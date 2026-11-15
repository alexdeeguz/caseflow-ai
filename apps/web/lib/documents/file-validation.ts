import { documentFileSchema, DocumentLimits, type DocumentFile } from '@caseflow/schemas';

export const documentAccept = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';

export function validateFile(file: Pick<File, 'name' | 'size' | 'type'>): DocumentFile {
  if (!file.size) {
    throw new Error('This file is empty. Choose a file with content.');
  }
  if (file.size > DocumentLimits.FileSizeBytes) {
    throw new Error('Each file must be 25 MiB or smaller.');
  }
  const result = documentFileSchema.safeParse({
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  });
  if (!result.success) {
    throw new Error(
      'Choose a PDF, JPEG, or PNG with a matching extension and a valid filename (up to 255 characters).',
    );
  }
  return result.data;
}
