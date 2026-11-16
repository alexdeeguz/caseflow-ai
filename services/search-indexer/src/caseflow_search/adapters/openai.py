from openai import APIConnectionError, APIStatusError, APITimeoutError, OpenAI

from ..constants import EMBEDDING_DIMENSIONS, MODEL, FailureCode
from ..errors import IndexFailure, RetryableError
from ..models import EmbeddingResult


class OpenAIEmbeddingProvider:
    def __init__(self, client: OpenAI) -> None:
        self._client = client

    def embed(self, texts: list[str]) -> EmbeddingResult:
        try:
            response = self._client.embeddings.create(
                model=MODEL, input=texts, encoding_format='float', timeout=30
            )
        except (APIConnectionError, APITimeoutError):
            raise RetryableError('Embedding request did not complete') from None
        except APIStatusError as error:
            # Rate limits and provider errors are worth retrying; other rejections are terminal.
            if error.status_code == 429 or error.status_code >= 500:
                raise RetryableError('Embedding provider is unavailable') from None
            raise IndexFailure(FailureCode.PROVIDER_UNAVAILABLE) from None
        vectors = [item.embedding for item in sorted(response.data, key=lambda item: item.index)]
        if len(vectors) != len(texts) or any(
            len(vector) != EMBEDDING_DIMENSIONS for vector in vectors
        ):
            raise IndexFailure(FailureCode.PROVIDER_UNAVAILABLE)
        return EmbeddingResult(
            vectors=vectors, input_tokens=response.usage.prompt_tokens if response.usage else None
        )
