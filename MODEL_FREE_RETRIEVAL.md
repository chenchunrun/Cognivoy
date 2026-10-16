# Model-free knowledge retrieval

[中文指南](#中文指南)

Cognivoy's **keyword** retrieval profile uses BM25 to search extracted document
text. It needs **no embedding model, Ollama server, embedding API key, GPU, or
downloaded tokenizer/model weights**. It is the recommended lightweight option
for deployments that want document retrieval without another model service.

This describes the retrieval layer, not a model-free tutor: Chat and generated
answers still use the language-model profile you configure. Other knowledge-base
engines and optional document parsers have their own requirements.

## Choose and configure a profile

The default full-app and CLI installations do not install LlamaIndex, FAISS, or
NLTK. Keyword loading and retrieval use plain text records, including read-only
access to historical LlamaIndex JSON text stores. Vector/hybrid retrieval needs
`pip install 'cognivoy[rag-llamaindex]'` (CLI-only:
`pip install 'cognivoy-cli[rag-llamaindex]'`) plus an embedding service.
Review [optional dependency risks](SECURITY.md) before enabling this extra.
An upgrade in an existing environment does not uninstall old dependencies;
use a fresh virtual environment for a default-only deployment.

New installations, missing profiles, and invalid profile values default to
`keyword`. Existing valid, explicitly saved `hybrid` or `vector` settings are
preserved; an upgrade does not silently replace that choice.

| LlamaIndex profile | Retrieval | Embedding service required |
| --- | --- | --- |
| `keyword` | BM25 over extracted text | No |
| `hybrid` | Keyword and vector retrieval | Yes |
| `vector` | Vector retrieval | Yes |

In the Web app, open **Settings → Embedding** (`/settings/embedding`). Under
**Knowledge retrieval mode**, select **Keyword (no model)** and **Save**.
The embedding-provider editor below it is optional while keyword mode is active.
The setting is stored as `retrieval_profile` in
`data/user/settings/llamaindex.json`.

For a process-level override, set the environment variable when starting the
application; project-root `.env` files are not read:

```sh
COGNIVOY_RAG_RETRIEVAL_PROFILE=keyword cognivoy start
```

The same override applies to CLI operations. Set it on the service/container's
actual process environment, then restart that service to apply an environment
change. A process override takes precedence over the saved setting; remove the
override if you want the Web setting to control the profile again.

## Existing libraries and document lifecycle

- This profile applies to **LlamaIndex** knowledge bases. It does not change a
  PageIndex, GraphRAG, LightRAG, IMA, or Obsidian connection into a keyword index.
- Existing LlamaIndex libraries can reuse extracted text from their current
  `docstore.json`, without loading vectors or contacting the old embedding
  endpoint. A library must have a readable text store, not only vector data.
- New text-based libraries, document additions, and rebuilds are supported.
  Keyword indexing writes a separate `keyword_index/chunks.json` sidecar inside
  the library and publishes it atomically. It does not overwrite the original
  vector index or its previous versions.
- Changes indexed only in keyword mode do not refresh the old vector index.
  If you later return to `hybrid` or `vector`, configure the intended embedding
  service and rebuild that index from the current sources. Keep the original
  source documents for rebuilds.

Text extraction remains a separate step. Plain text and documents with an
extractable text layer can use a suitable text parser. Scans and image-only PDFs
need usable OCR/text extraction first; the selected OCR/parser may independently
require packages, a service, model downloads, or credentials. Keyword retrieval
does not supply OCR and does not bypass an extraction failure.

## Matching and limits

English terms are matched as normalized keywords, and Chinese text uses
overlapping two-character tokens, without downloading a segmentation model.
Use terminology that appears in your materials: for example, try an English
technical term when the source is an English course.

BM25 is lexical retrieval. It does **not** promise synonym understanding,
semantic similarity, or cross-language matching. Vector or hybrid retrieval can
be selected explicitly when those properties are needed, with an appropriate
embedding model and separate relevance testing.

When no terms match, retrieval returns no source fragments. The query itself is
not a source, and an empty source list is not proof that the library is broken.
Try a specific term from a known document; inspect the extracted text if that
also produces no match. A provider or indexing error must remain an error, not
be accepted as retrieved evidence.

## Verify a deployment

1. Save keyword mode and upload a small text document containing a distinctive
   phrase, or select an existing LlamaIndex library with a text store.
2. Search for that phrase and inspect the returned excerpt and its source.
3. Search for an unrelated distinctive phrase; expect no source fragments.
4. Add a second document and verify its term is searchable. If rebuilding,
   verify the active sources again and retain the original vector index.

These checks prove text retrieval, not the full tutoring workflow. Verify a
grounded Chat answer separately with the configured language model. See
[optional capability deployment and acceptance](OPTIONAL_CAPABILITIES.md) for
Manim, voice, image, and video requirements.

## 中文指南

默认完整应用和 CLI 安装不再引入 LlamaIndex、FAISS 或 NLTK。关键词检索直接读取
文本及历史 JSON 文本库。向量/混合检索需额外安装 `cognivoy[rag-llamaindex]`
（仅 CLI 使用 `cognivoy-cli[rag-llamaindex]`），并配置嵌入服务。请先阅读
[可选依赖风险](SECURITY.md)。升级不会自动卸载旧环境已有依赖；默认轻量部署应使用
新建虚拟环境。

`keyword` 是基于已提取文本的 BM25 关键词检索，无需嵌入模型、Ollama、嵌入 API
密钥或 GPU，也不会下载分词模型或模型权重。它是推荐的轻量部署方案；这不表示
整个辅导系统不需要模型，聊天与生成答案仍使用已配置的语言模型。

新安装、缺失配置或非法配置值默认使用 `keyword`；已保存的有效 `hybrid` / `vector`
选择保持不变。进入 **设置 → Embedding**，在 **Knowledge retrieval mode**
（知识检索模式）选择 **Keyword (no model)**（关键词，无模型）并保存。也可启动时
设置 `COGNIVOY_RAG_RETRIEVAL_PROFILE=keyword`；环境覆盖优先于保存值，修改服务环境后
需重启，项目根目录 `.env` 不生效。

该模式仅适用于 LlamaIndex 知识库。已有库可复用 `docstore.json` 中的文本而不读取
向量、不连接旧嵌入服务。文字资料支持新建、追加和重建；独立的
`keyword_index/chunks.json` 文件不会覆盖原向量索引。以后改回向量或混合模式时，
需配置嵌入服务，并根据当前来源重建向量索引，不能把旧向量当作已更新。

英文按关键词匹配，中文使用相邻双字匹配，不承诺同义词、跨语言语义或语义相似度。
优先使用资料中的术语；英文课程可尝试原文关键词。无匹配时来源列表为空，不将查询
回显伪装成来源。扫描图片与图像 PDF 必须先有可用的文本提取，OCR 或解析器可能
独立需要服务、依赖、模型或凭证。

验收时分别检查已知词命中及来源片段、无关词返回空来源、追加资料可检索和重建后
来源正确；再单独验证基于知识库的真实聊天答案。语音、图片、视频和动画的部署边界
见[可选能力说明](OPTIONAL_CAPABILITIES.md)。
