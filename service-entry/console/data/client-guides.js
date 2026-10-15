// Client guides for /access/clients (07 §6.10, 05 §13.4): how to point common
// apps at the gateway. Templates carry three placeholders the page fills in:
//   {baseUrl}      the OpenAI-compatible base URL of the chosen route
//   {anthropicUrl} the Anthropic-compatible base URL of the chosen route
//   {model}        the model id the person typed (default `auto`)
// and `$API_KEY`, which is never replaced: it names the shell variable (or
// the placeholder in a settings box) that holds the person's own key. The
// page never sees a real key.
//
// Titles are product names and stay as written; steps are catalog keys
// (`access.clients.<id>.step<N>`), so the guides read in both languages.

export const GUIDE_FIELD_KEYS = Object.freeze({
  baseUrl: "access.clients.field.baseUrl",
  key: "access.clients.field.key",
  model: "access.clients.field.model",
  provider: "access.clients.field.provider",
});

export const CLIENT_GUIDES = Object.freeze([
  Object.freeze({
    id: "openwebui",
    name: "Open WebUI",
    protocol: "openai",
    steps: Object.freeze(["access.clients.openwebui.step1", "access.clients.openwebui.step2", "access.clients.openwebui.step3"]),
    rows: Object.freeze([
      Object.freeze({ label: GUIDE_FIELD_KEYS.baseUrl, value: "{baseUrl}" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.key, value: "$API_KEY" }),
    ]),
    snippets: Object.freeze([
      Object.freeze({ id: "env", label: "access.clients.snippet.env", language: "bash", code: "OPENAI_API_BASE_URL={baseUrl}\nOPENAI_API_KEY=$API_KEY" }),
    ]),
  }),
  Object.freeze({
    id: "claude-code",
    name: "Claude Code",
    protocol: "anthropic",
    steps: Object.freeze(["access.clients.claude-code.step1", "access.clients.claude-code.step2"]),
    rows: Object.freeze([]),
    snippets: Object.freeze([
      Object.freeze({ id: "bash", label: "access.clients.snippet.bash", language: "bash", code: "export ANTHROPIC_BASE_URL={anthropicUrl}\nexport ANTHROPIC_AUTH_TOKEN=$API_KEY\nexport ANTHROPIC_MODEL={model}\nclaude" }),
      Object.freeze({ id: "powershell", label: "access.clients.snippet.powershell", language: "powershell", code: "$env:ANTHROPIC_BASE_URL = \"{anthropicUrl}\"\n$env:ANTHROPIC_AUTH_TOKEN = $API_KEY\n$env:ANTHROPIC_MODEL = \"{model}\"\nclaude" }),
    ]),
  }),
  Object.freeze({
    id: "opencode",
    name: "OpenCode",
    protocol: "openai",
    steps: Object.freeze(["access.clients.opencode.step1", "access.clients.opencode.step2"]),
    rows: Object.freeze([]),
    snippets: Object.freeze([
      Object.freeze({
        id: "config",
        label: "access.clients.snippet.config",
        language: "json",
        code: "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"provider\": {\n    \"local-ai\": {\n      \"npm\": \"@ai-sdk/openai-compatible\",\n      \"name\": \"Local AI\",\n      \"options\": { \"baseURL\": \"{baseUrl}\", \"apiKey\": \"{env:API_KEY}\" },\n      \"models\": { \"{model}\": { \"name\": \"{model}\" } }\n    }\n  }\n}",
      }),
    ]),
  }),
  Object.freeze({
    id: "chatbox",
    name: "Chatbox",
    protocol: "openai",
    steps: Object.freeze(["access.clients.chatbox.step1", "access.clients.chatbox.step2", "access.clients.chatbox.step3"]),
    rows: Object.freeze([
      Object.freeze({ label: GUIDE_FIELD_KEYS.provider, value: "OpenAI API (compatible)" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.baseUrl, value: "{baseUrl}" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.key, value: "$API_KEY" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.model, value: "{model}" }),
    ]),
    snippets: Object.freeze([]),
  }),
  Object.freeze({
    id: "cherry-studio",
    name: "Cherry Studio",
    protocol: "openai",
    steps: Object.freeze(["access.clients.cherry-studio.step1", "access.clients.cherry-studio.step2", "access.clients.cherry-studio.step3"]),
    rows: Object.freeze([
      Object.freeze({ label: GUIDE_FIELD_KEYS.provider, value: "OpenAI" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.baseUrl, value: "{baseUrl}" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.key, value: "$API_KEY" }),
      Object.freeze({ label: GUIDE_FIELD_KEYS.model, value: "{model}" }),
    ]),
    snippets: Object.freeze([]),
  }),
  Object.freeze({
    id: "curl",
    name: "curl",
    protocol: "openai",
    steps: Object.freeze(["access.clients.curl.step1"]),
    rows: Object.freeze([]),
    snippets: Object.freeze([
      Object.freeze({
        id: "openai",
        label: "access.clients.snippet.openai",
        language: "bash",
        code: "curl {baseUrl}/chat/completions \\\n  -H \"Authorization: Bearer $API_KEY\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\": \"{model}\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}]}'",
      }),
      Object.freeze({
        id: "anthropic",
        label: "access.clients.snippet.anthropic",
        language: "bash",
        code: "curl {anthropicUrl}/v1/messages \\\n  -H \"x-api-key: $API_KEY\" \\\n  -H \"anthropic-version: 2023-06-01\" \\\n  -H \"Content-Type: application/json\" \\\n  -d '{\"model\": \"{model}\", \"max_tokens\": 256, \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}]}'",
      }),
    ]),
  }),
  Object.freeze({
    id: "python",
    name: "Python",
    protocol: "openai",
    steps: Object.freeze(["access.clients.python.step1", "access.clients.python.step2"]),
    rows: Object.freeze([]),
    snippets: Object.freeze([
      Object.freeze({
        id: "openai",
        label: "access.clients.snippet.openai",
        language: "python",
        code: "import os\nfrom openai import OpenAI\n\nclient = OpenAI(base_url=\"{baseUrl}\", api_key=os.environ[\"API_KEY\"])\nreply = client.chat.completions.create(\n    model=\"{model}\",\n    messages=[{\"role\": \"user\", \"content\": \"Hello\"}],\n)\nprint(reply.choices[0].message.content)",
      }),
    ]),
  }),
]);
