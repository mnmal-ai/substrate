# @mnmal-ai/substrate-embedder

Internal: bundled into `@mnmal-ai/substrate` and not published; it is not part of the public surface, except `FakeEmbedder`, which `@mnmal-ai/substrate/testing` exports.

The `Embedder` interface for Substrate semantic recall, with two implementations.

An embedder answers "give me a vector for this text". This package defines the `Embedder` interface and `EmbedError`, and ships:

- `OnnxEmbedder`: in-process, via [fastembed](https://www.npmjs.com/package/fastembed) (ONNX Runtime). `fastembed` is not declared as a dependency, because it is large; install it in the runtime (`pnpm add fastembed`; `substrate init --embedder=minilm|bge-base` adds it) if you use this embedder.
- `OllamaEmbedder`: calls a local [Ollama](https://ollama.com) server's `/api/embed`.

## Where it fits

Used by the built-in recall plugin, which reads its embedder settings (`kind`, `model`, `dimension`, …) from `<SUBSTRATE_PLUGIN_DIR>/substrate-recall.config.json`. The interface is small enough to stub in tests.

## Sharing an Ollama server

Ollama keeps **one loaded runner per model**, and runner options are part of that runner. Read this before pointing a second client at the same model.

- **Every client of a model must send the same `num_ctx`/`num_batch`, or none.** A request with different options forces Ollama to reload the model, evicting whichever client loaded it last. Two clients alternating thrash each other, and each switch costs seconds.
- **Never send `keep_alive: -1` to a shared server.** A pinned runner can never be evicted, so a client that needs it reloaded waits for Ollama's load timeout (5 minutes by default) on every request. Use a finite duration such as `24h`.
- **Without options, `/api/embed` truncates silently at 2048 tokens**, which is Ollama's default batch size, not the model's context. A long input reporting `prompt_eval_count: 2048` was cut. `OllamaEmbedder` sends the model's context length as `num_ctx` and `num_batch` for this reason, so other clients of the same model should send the same values.

## More

- Source: `packages/substrate-embedder/src/`
- Recall plugin: `plugins/substrate-recall/`
