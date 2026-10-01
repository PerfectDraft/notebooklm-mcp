# Tools

Every tool registered in v2.0.0, with parameter schema, an example invocation (MCP `tools/call` arguments shape), and the expected return shape. New v2 tools are flagged.

The server returns each tool result wrapped as `{ "success": true, "data": <object> }` (or `{ "success": false, "error": <string> }`). The shapes below describe the inner `data`.

---

## ask_question

Ask a question against a notebook. Reuses an existing browser session when `session_id` is supplied. Citation extraction reads the DOM citation panel after the answer settles.

**v2 additions**: `source_format`, `_provenance` envelope on the result, AI-generated answer prefix.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `question` | string | yes | The question to ask. |
| `session_id` | string | no | Reuse an existing session for context. Omit to create a new one. |
| `notebook_id` | string | no | Library notebook ID. Falls back to active notebook. |
| `notebook_url` | string | no | Ad-hoc NotebookLM URL. Overrides `notebook_id`. |
| `source_format` | `none` \| `inline` \| `footnotes` \| `json` | no | Citation rendering. Default `none`. |
| `show_browser` | bool | no | Shorthand for `browser_options.show`. |
| `browser_options` | object | no | Per-call browser overrides — see [`docs/configuration.md`](./configuration.md#per-call-browser-options). |

### Example

```json
{
  "name": "ask_question",
  "arguments": {
    "question": "How does the OAuth refresh token rotation work?",
    "notebook_id": "auth-notebook",
    "source_format": "footnotes"
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "question": "How does the OAuth refresh token rotation work?",
  "answer": "[AI-GENERATED ...] The refresh token is rotated each ...\n\nSources:\n[1] auth-spec.pdf — ...",
  "session_id": "ses_…",
  "notebook_url": "https://notebooklm.google.com/notebook/…",
  "session_info": {
    "age_seconds": 12,
    "message_count": 3,
    "last_activity": "2026-04-30T12:00:00.000Z"
  },
  "_provenance": {
    "provider": "google-notebooklm",
    "model": "gemini-2.5",
    "via": "chrome-automation",
    "grounding": "user-uploaded-documents",
    "ai_generated": true
  },
  "source_format": "footnotes",
  "sources": [
    { "index": 1, "title": "auth-spec.pdf", "excerpt": "Refresh tokens MUST be rotated…" }
  ]
}
```

`sources` is omitted when `source_format=none` or when no citations were found.

---

## add_source — updated in v2.1

Add a source to a notebook. Supports `type=url` (web crawl), `type=text` (raw paste), `type=file` (local PDF/DOCX/TXT/MD upload), and `type=youtube` (video transcript).

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `type` | `url` \| `text` \| `file` \| `youtube` | yes | Type of source to ingest. YouTube URLs passed as `url` are auto-routed. |
| `content` | string | yes | URL when `type=url`/`youtube`, raw text when `type=text`, local file path when `type=file`. |
| `title` | string | no | Optional display title. NotebookLM picks a default. |
| `session_id` | string | no | Reuse an existing browser session. |
| `notebook_id` | string | no | Library notebook ID. |
| `notebook_url` | string | no | Ad-hoc URL. Overrides `notebook_id`. |
| `show_browser` | boolean | no | Show browser for debugging. |

### Example

```json
{
  "name": "add_source",
  "arguments": {
    "type": "file",
    "content": "D:/docs/research_paper.pdf",
    "title": "Research Paper 2026"
  }
}
```

---

## list_sources — new in v2.1

List all sources currently ingested in a notebook with their index, display title, and active status.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `session_id` | string | no | Reuse an existing browser session. |
| `notebook_id` | string | no | Library notebook ID. |
| `notebook_url` | string | no | Ad-hoc URL. Overrides `notebook_id`. |
| `show_browser` | boolean | no | Show browser for debugging. |

### Return shape

```jsonc
{
  "sources": [
    {
      "index": 1,
      "title": "Research Paper 2026.pdf",
      "selected": true
    }
  ],
  "count": 1
}
```

---

## generate_audio — new in v2

Generate a podcast-style Audio Overview for a notebook. Resolves when the audio element is ready.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `custom_prompt` | string | no | Optional focus prompt. |
| `timeout_ms` | number | no | Wait ceiling. Default `600000`. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "generate_audio",
  "arguments": {
    "custom_prompt": "Focus on the migration strategy",
    "timeout_ms": 900000
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "ready": true,
  "duration_ms": 412000
}
```

Pair with `download_audio` to persist the file. Video / Infographic / Slides are not in v2.0.0.

---

## download_audio — new in v2

Download the most recent Audio Overview to disk.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `destination_dir` | string | yes | Absolute directory. Created if missing. |
| `session_id` | string | no | |
| `notebook_id` | string | no | |
| `notebook_url` | string | no | |

### Example

```json
{
  "name": "download_audio",
  "arguments": {
    "destination_dir": "/Users/me/Downloads/notebooklm"
  }
}
```

### Return shape

```jsonc
{
  "status": "success",
  "file_path": "/Users/me/Downloads/notebooklm/overview-2026-04-30.wav",
  "size_bytes": 9_412_000
}
```

Run `generate_audio` first if no Audio Overview exists yet.

---

## add_notebook

Add a NotebookLM share-URL to the local library. The tool description enforces a confirmation workflow on the host agent — do not call without explicit user consent.

### Parameters

| Name | Type | Required | Notes |
|---|---|---|---|
| `url` | string | yes | NotebookLM share URL. |
| `name` | string | yes | Display name. |
| `description` | string | yes | Short description of the notebook content. |
| `topics` | string[] | yes | Topics covered. |
| `content_types` | string[] | no | e.g. `["documentation", "examples"]`. |
| `use_cases` | string[] | no | When to consult this notebook. |
| `tags` | string[] | no | Optional organizational tags. |

### Return shape

```jsonc
{
  "status": "added",
  "id": "nb_abcd",
  "name": "n8n Documentation",
  "active": true
}
```

---

## list_notebooks

No parameters. Returns the full library.

### Return shape

```jsonc
{
  "active_notebook_id": "nb_abcd",
  "notebooks": [
    {
      "id": "nb_abcd",
      "name": "n8n Documentation",
      "url": "https://notebooklm.google.com/notebook/…",
      "description": "n8n core + builtin nodes",
      "topics": ["workflow automation", "n8n"],
      "use_cases": ["building n8n workflows"],
      "tags": ["docs"],
      "use_count": 42
    }
  ]
}
```

---

## get_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

Returns one entry from `list_notebooks`.

---

## select_notebook

Set a notebook as the active default.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

### Return shape

```jsonc
{ "status": "active", "id": "nb_abcd", "name": "n8n Documentation" }
```

---

## update_notebook

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |
| `name` | string | no |
| `description` | string | no |
| `topics` | string[] | no |
| `content_types` | string[] | no |
| `use_cases` | string[] | no |
| `tags` | string[] | no |
| `url` | string | no |

Returns the updated entry.

---

## remove_notebook

Removes the entry from the local library only — does not delete the notebook in NotebookLM.

| Name | Type | Required |
|---|---|---|
| `id` | string | yes |

---

## search_notebooks

Searches name, description, topics, tags.

| Name | Type | Required |
|---|---|---|
| `query` | string | yes |

Returns an array of matching entries.

---

## get_library_stats

No parameters. Returns total notebooks, total queries, top-used notebooks.

---

## list_sessions

No parameters. Returns active sessions with age, message count, last-activity timestamp.

---

## close_session

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## reset_session

Clears chat history while keeping the same `session_id`.

| Name | Type | Required |
|---|---|---|
| `session_id` | string | yes |

---

## get_health

No parameters.

### Return shape

```jsonc
{
  "status": "ok",
  "authenticated": true,
  "active_sessions": 1,
  "version": "2.0.0",
  "config": {
    "headless": true,
    "stealth_enabled": true,
    "max_sessions": 10,
    "answer_timeout_ms": 600000
  }
}
```

When `authenticated=false` the response also carries a `troubleshooting_tip` pointing at `setup_auth` / `cleanup_data`.

---

## setup_auth

Opens a visible Chrome for first-time Google login.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true` for setup. |
| `browser_options` | object | no | Same shape as `ask_question`. |

Returns immediately after the window is opened. The user has up to 10 minutes to complete the login. Verify with `get_health` afterwards.

---

## re_auth

Closes all sessions, deletes saved cookies + Chrome profile, opens a fresh login window.

| Name | Type | Required | Notes |
|---|---|---|---|
| `show_browser` | bool | no | Default `true`. |
| `browser_options` | object | no | |

---

## cleanup_data

Categorised preview + delete of every NotebookLM MCP file the server can find on the system. Designed for fresh-start workflows.

| Name | Type | Required | Notes |
|---|---|---|---|
| `confirm` | bool | yes | `false` = preview only. `true` = delete after preview was reviewed. |
| `preserve_library` | bool | no | Keep `library.json` while wiping everything else. Default `false`. |

Workflow:

1. `cleanup_data({ confirm: false, preserve_library: true })` — see what will be deleted.
2. Close all Chrome instances.
3. `cleanup_data({ confirm: true, preserve_library: true })` — execute.

---

## Resources (read-only)

| URI | Purpose |
|---|---|
| `notebooklm://library` | JSON view of the full library. |
| `notebooklm://library/{id}` | One notebook by ID. The `{id}` template autocompletes from the library. |
| `notebooklm://metadata` | Deprecated. Use `notebooklm://library` instead. |

The MCP server does not respond to `mcp://notebooklm` — that URI scheme never existed. Use `notebooklm://`.
