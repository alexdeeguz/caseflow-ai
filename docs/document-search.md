# Document search

Document search finds passages in processed document text across the cases a user can access.
Results show the case, file, page, and a highlighted snippet, and open the document's details.

- **Smart search** (default) blends exact-word matches with meaning-based matches, so "treatment
  after the accident" also finds therapy notes that use different words.
- **Exact words** matches the words typed, for names, claim numbers, and codes. Quoted phrases and
  `-exclusions` are supported.

Search is available from the **Search** page in the workspace navigation (all accessible cases,
with case and archive filters) and from each case's **Documents** tab (that case only).

## Access

Search follows the same permissions as the rest of CaseFlow. Staff search only their assigned
cases; Admin and Super Admin search all cases. Only available documents are searchable: removed
documents disappear from results and return when restored. Archived cases are excluded by default
and can be included with the archive filter or by searching that case directly.

## How it works

1. **Indexing starts automatically.** When a document's text processing completes, an indexing job
   is recorded in the same database transaction and handed to a background worker.
2. **Text is chunked by page.** The worker reads the document's saved text and splits each page into
   overlapping passages, keeping page numbers so results can cite "p. 3". Scanned pages are included
   through their OCR text.
3. **Keyword search is available first.** Saving the passages makes the document searchable by
   exact words immediately.
4. **Embeddings add meaning-based search.** The worker then creates an embedding for each passage
   and stores it alongside the text. When this finishes, the document is fully searchable.
5. **Queries are ranked together.** A search takes the best full-text matches and the closest
   meaning-based matches from the cases the user can access, and merges them into one ranking.

Each document's search status appears in its details: _Searchable_, _Exact words only_,
_Preparing for search_, or _Not searchable_. Administrators can re-index a document whose indexing
did not fully complete.

## Design decisions

| Decision                                                         | Why                                                                                                                                                                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **pgvector in PostgreSQL** instead of a separate vector database | Search results go through the same row-level security as every other read, so access rules are enforced in one place, with no second data store to secure and keep in sync.             |
| **Hybrid search with reciprocal rank fusion**                    | Full-text search is precise for names and numbers; embeddings find paraphrases. Fusing ranks combines both without tuning score scales against each other.                              |
| **Page-scoped, overlapping passages**                            | Results can point to an exact page, and phrases near a passage boundary are still found.                                                                                                |
| **Keyword-first indexing**                                       | A document is useful for search as soon as its text is saved; meaning-based matching follows. If embedding fails or the daily AI allowance is reached, exact-word search keeps working. |
| **Query embedding outside the database transaction**             | No database connection waits on the AI provider, keeping the shared connection pool responsive.                                                                                         |
| **Graceful degradation**                                         | If meaning-based matching is unavailable, search returns exact-word results and says so instead of failing.                                                                             |
| **Highlights as character ranges**                               | The browser renders highlights itself and never receives markup from the server.                                                                                                        |
| **Separate indexing worker and queue**                           | Search indexing failures or load cannot delay document processing or fact extraction.                                                                                                   |

## Limits

| Limit                 | Value                                       |
| --------------------- | ------------------------------------------- |
| Query length          | 2–200 characters                            |
| Ranked results        | Up to 100, shown 20 per page                |
| Passages per document | Up to 500                                   |
| Embedding model       | OpenAI `text-embedding-3-small`             |
| AI cost allowance     | Shared daily allowance with fact extraction |

## Privacy

Smart search sends document passages (during indexing) and search queries to OpenAI to create
embeddings. Search text is not logged or audited. Use fictional data only.

## Current limitations

- Only processed document text is searchable; documents whose processing failed are not.
- Automatic recovery of stalled indexing jobs is not yet scheduled; administrators can re-index.
