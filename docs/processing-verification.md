# Processing workflow verification

[Back to README](../README.md)

Document processing is verified at two levels: automated suites against disposable local
databases, and end-to-end runs with fictional documents. Passing local tests shows the code and
database functions behave correctly; it does not by itself prove that separately hosted services
can communicate.

## Coverage boundaries

Disposable database tests exercise migrations, permissions, lifecycle functions, and
atomic publication. Provider substitutes exercise native extraction and OCR orchestration
without sending document data to external services. Linux package checks exercise
dependency architecture, packaged certificate trust, and parser memory enforcement.

Local tests cannot prove that independently hosted services can communicate. End-to-end
evidence belongs to a private verification record and uses fictional documents. Not every
race or malformed-file case is reproducible in a live workflow. Previews, extracted-text
display, and artifact cleanup remain separate work.

Versioned OCR notifications may include the source object version. The collector checks
it against the trusted database snapshot when present and rejects unknown fields or
mismatched versions.

## Automated checks

The automated matrix uses disposable local databases and fictional fixtures, without
hosted secrets or cloud credentials. [Local development](development.md#verification)
contains commands and test configuration. Infrastructure and Linux package coverage is
described in [runtime validation](lambda-configuration.md#build-and-validation).
The macOS unit suite does not exercise Linux address-space enforcement; the container
package check covers that limit.

| Area             | Required evidence                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extraction       | Native, scanned, mixed, sparse, blank, malformed, encrypted, oversized PDF/image fixtures; all pages considered                                        |
| Source integrity | Saved S3 version only; size, signature, checksum, and source mismatch rejection                                                                        |
| Delivery         | Duplicates, early notifications, uncertain starts, lost acknowledgments, bounded pagination, throttling                                                |
| Publication      | Fenced leases, one atomic result/audit, stale collector rejection, S3 success followed by database failure                                             |
| Authorization    | Staff/Admin boundaries, disabled users, removed documents, archived cases, inaccessible IDs                                                            |
| Recovery         | Same-job outbox redispatch, three-recovery limit, missed notifications, six-day cutoff, budget preservation                                            |
| Upgrade          | Upgrade the earlier processing schema; preserve users, assignments, documents, sessions, jobs, dispatches, audit; repeat seeds only on disposable data |
| Contracts        | Shared TypeScript/Python queue fixtures, strict public responses, no storage/provider/credential fields                                                |
