import { DocumentContentType } from '@caseflow/schemas';

export function DocumentIcon({ contentType }: { contentType?: DocumentContentType }) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z" />
      <path d="M14 2v6h6" />
      {contentType && contentType !== DocumentContentType.Pdf ? (
        <>
          <circle cx="9" cy="12" r="1" />
          <path d="m7 18 3-3 2 2 3-4 2 5Z" />
        </>
      ) : (
        <>
          <path d="M8 13h8M8 17h5" />
        </>
      )}
    </svg>
  );
}
