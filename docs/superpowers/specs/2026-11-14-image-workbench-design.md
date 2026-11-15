# FRAME Local Image Workbench

Build a Windows local web application with a Chinese interface. The user has
authorized implementation and local execution. Work in a separate new folder.

## Architecture

Node.js 24 runs an Express service on 127.0.0.1. React and Vite produce the
frontend served by that service. Settings, reference images, generated images
and task history stay in the project's data directory. No account system or
remote deployment is required.

Use the official OpenAI Images API: JSON generations for prompts without
references and multipart edits for prompts with references. A connection has
a display name, base URL, API key and editable model list. Each task selects
its own connection, model, prompt, size, image count, quality, output format,
background, references and optional JSON parameters.

## User Workflows

- The workbench contains independent editable task panels. Add, duplicate,
  remove, submit individually or submit all eligible drafts.
- Reference images support multiple file selection and drag/drop, preview and
  removal. Accept PNG, JPEG and WebP, up to 16 files, 20 MiB each.
- Default concurrency is 3, configurable from 1 to 8. Jobs queue when full.
  Cancelling an active job aborts the HTTP request. No automatic paid retries.
- Results are saved locally and support preview, download, reuse as reference,
  history search, and restoring a historical task into a new editable panel.
- Settings support multiple API connections, preserving saved keys when the
  key field is left empty, explicit key removal, connection testing and model
  discovery. Connection tests call the models endpoint only.
- A Windows launcher installs missing dependencies, builds the interface,
  starts the service in a hidden window and opens the local URL.

## Persistence And Errors

The browser never receives saved API keys. They are kept in a local
data/settings.json file; this is documented as local plaintext storage.
The server accepts local Host values and same-origin mutations only.
Input validation precedes enqueueing. Persist queue state through atomic
writes. Restarted queued/running jobs become interrupted, requiring deliberate
resubmission. API errors are shown per task and redact credentials.

## Model Compatibility

Initial models follow the fetched official OpenAI image documentation:
gpt-image-2.6-flare, gpt-image-2.5-flare, gpt-image-2, gpt-image-1.5,
gpt-image-1-mini and chatgpt-image-latest. Account availability is determined
by the configured connection. Users can add/remove model IDs.

Use auto, 1024x1024, 1536x1024 and 1024x1536 size presets; newer image models
also permit validated custom dimensions. Older GPT Image models reject
unsupported custom sizes. Transparent background requires PNG or WebP.
Never send response_format to GPT Image models. Additional parameters cannot
replace protected request fields or enable an unsupported streaming response.

## Verification

Use node:test for queue concurrency, cancellation, restart behavior, argument
validation, provider JSON/multipart requests and integration against a local
fake upstream API. Use Playwright CLI for desktop/mobile layouts, uploads,
settings, task editing, generation, history and download flows. Real paid
generation is not performed without user-supplied credentials.

## Official References

- https://developers.openai.com/api/docs/guides/image-generation
- https://developers.openai.com/api/reference/resources/images/methods/generate
- https://developers.openai.com/api/reference/resources/images/methods/edit
