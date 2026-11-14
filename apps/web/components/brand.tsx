export function Brand() {
  return (
    <span className="inline-flex items-center gap-3" aria-label="CaseFlow AI">
      <svg aria-hidden="true" width="38" height="38" viewBox="0 0 38 38" fill="none">
        <rect width="38" height="38" rx="10" fill="var(--brand-yellow)" />
        <path
          d="M25 11H16a7 7 0 0 0 0 14h9M19 18h9M24 14l4 4-4 4"
          stroke="var(--brand-navy)"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span className="text-xl font-extrabold tracking-tight">
        CaseFlow<span className="ml-1.5 text-accent">AI</span>
      </span>
    </span>
  );
}
