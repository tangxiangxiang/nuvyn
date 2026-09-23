# AI

## Configure a Provider

Open Settings and choose either Anthropic or OpenAI. Enter the API key and, if needed, override the model or HTTP(S) base URL. Each provider keeps a separate saved configuration; switching providers does not copy credentials between them.

The OpenAI provider uses the streaming OpenAI-compatible Chat Completions
protocol. Its Base URL is an API root such as `https://api.openai.com/v1` (or a
custom path prefix), not the full `/chat/completions` endpoint. Nuvyn appends
that endpoint itself. Chat workspace actions require function/tool calling;
some OpenAI-compatible gateways support text generation but not the tools
required for file actions, and Nuvyn reports that incompatibility instead of
silently continuing without tools. During chat, streamed tokens are forwarded
to the UI and persisted with the session.

API keys are sent only to the Nuvyn server, encrypted before SQLite storage, and never returned to the browser. Provider environment variables such as `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` are not supported configuration paths.

See [Deployment Security](../deployment/security.md) for the master-key model.

If provider credentials were encrypted with the auto-managed key and
`data/.nuvyn-master-key` is unavailable, Nuvyn reports that the master key is
required. It does not generate a replacement key or modify the encrypted
credentials. Restore the original file from backup, or configure the matching
key through `NUVYN_MASTER_KEY` or `NUVYN_MASTER_KEY_FILE`. The runtime accepts
only the canonical Nuvyn key sources.

## Test the Current Connection

Settings → AI includes a real, manual connection probe for the configuration
currently shown in the form. Choose Anthropic or OpenAI, enter a new API key or
keep the existing credential, set the Base URL and model, then click **Test
connection**. Opening Settings, changing a field, switching providers, or
saving does not contact the provider automatically.

The probe tests the displayed provider, credential, Base URL, and model as one
configuration. A newly entered API key is used immediately without being saved;
when the API Key field is empty, Nuvyn reuses the selected provider's saved key
for a read-only test. Unsaved Base URL and model values are also used. The probe
does not save these transient values or modify Settings. It makes a small
provider request, so a successful test may use a small amount of API quota.

The status is local to the Settings page and has four states:

- **Not tested** — the current form has not been checked.
- **Testing** — a probe is in progress.
- **Connected** — the exact displayed provider, credential, Base URL, and model completed a real Nuvyn-compatible probe. The result includes the provider, model, and latency.
- **Connection failed** — the probe did not complete successfully and can be run again.

Editing the provider, API key, Base URL, or model invalidates an old Connected
status and returns it to **Not tested**. The same happens after saving or
clearing a key, so the status never represents an older configuration.

The probe is deliberately closer to a real Nuvyn chat request than to a simple
model-list lookup. OpenAI uses a small non-streaming Chat Completions request
with one harmless tool definition and `tool_choice: auto`; Anthropic uses the
equivalent minimal Messages request. A normal text response or a valid
tool-capable response is enough. The harmless tool is not a workspace mutation.

### Connection troubleshooting

- **Authentication failure:** check the API key or token and that the provider account permits the request.
- **Model unavailable:** confirm that the selected model exists for the configured provider. This status is used only when the provider explicitly identifies a model problem.
- **Connection failure:** check the network and Base URL. For OpenAI-compatible providers, use the API root, such as `https://api.openai.com/v1`; Nuvyn appends `/chat/completions` itself. A generic HTTP 400 or 404 can indicate a wrong endpoint, gateway prefix, or request shape rather than a missing model.
- **Connection timeout:** verify the Base URL and network path. The probe has a bounded timeout of about 10 seconds.
- **Tool/function-calling unsupported:** the OpenAI-compatible endpoint may support plain text generation but reject the tool capability Nuvyn needs for workspace actions. Use a provider or model that supports tool/function calling.

Provider errors are sanitized before they reach the browser, and API keys are
redacted from visible error messages.

## Chat and Context

Each Note has one persistent AI thread keyed by its stable document identity, so renaming or moving a Note keeps its conversation attached. When no Note is open, the assistant uses a separate workspace thread. The interface does not expose a session history picker.

Raw user messages, assistant replies, and tool-call records remain in SQLite. As a thread grows, Nuvyn compacts older turns into a working summary for model requests while keeping the raw transcript for recovery. The thread API and panel load only messages after the latest compact checkpoint, capped at the most recent 40 messages; older raw messages are not sent to the browser.

At Send time, Nuvyn captures the active workspace view rather than assuming the route is current. The context can be:

- the live editor buffer, including unsaved text and external-conflict state;
- a History or diff view;
- a browser-local Recovery draft and, when relevant, the disk version.

You can attach additional vault documents from the composer. Attachments are path references; the model reads them with a server tool if needed. The live workspace snapshot is used for that request only and is not copied into the stored chat message.

## File Tools

The model can call `read_file`, `list_files`, `create_file`, `write_file`, `patch_file`, `delete_file`, `rename_file`, and `update_metadata`. Tool calls take effect when the server executes them; there is no transactional rollback for earlier successful calls if a later call fails or the response is stopped.

All paths are vault-relative and server validated. Mutation tools share the editor's atomic-write and lifecycle rules. When the active document is dirty, read-only, stale, externally conflicted, or no longer has the expected identity, the server rejects an unsafe mutation instead of applying it blindly.

Review tool-call cards and History changes after an AI-assisted edit. Create a Git version only after the result is acceptable.

## Troubleshooting

- **Not configured:** save a key for the active provider in Settings.
- **Master-key error:** restore the exact key that encrypted the stored credentials. If the key is permanently unavailable, use Settings → AI → Forget the affected provider API key and confirm the destructive action. This removes only that provider's encrypted credential; Nuvyn never clears or replaces credentials automatically. After all unrecoverable provider credentials are explicitly cleared, a new API key can be saved and a new fallback key will be created.
- **Tool rejected:** save or resolve the active workspace state, then ask the model to re-read before retrying.
- **Provider error:** verify the selected model, network access, and API account. For OpenAI-compatible providers, verify that the Base URL is the API root (not `/chat/completions`) and that the endpoint supports streaming Chat Completions and tool/function calling.
