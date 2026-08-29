"""Speaker-verification service: eres2net embeddings + similarity ranking.

Run as its own container (`FROM worker AS verify`, uvicorn :8001) so the API
image stays torch-free. The API orchestrates; this package owns the model, the
embedding cache, and every floating-point operation.
"""
