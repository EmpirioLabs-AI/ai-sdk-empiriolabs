# Changelog

## 0.1.1

- Published from the Publish workflow through npm trusted publishing (OpenID Connect), with no stored npm token.

## 0.1.0

- First release. Works with AI SDK 7 (`ai`) and Zod 3.25 or 4.
- Six tools for AI SDK agents: `generateImage` (text to image and image editing), `generateVideo` (text to video and image to video), `checkGenerationJob`, `textToSpeech`, `transcribeAudio`, and `findModels`, plus `empiriolabsTools()` to add them all at once.
- When a tool call names no model, the tool uses a featured model for that task from the live EmpirioLabs AI catalog. A tool call or the tool options can name any model ID.
- A job that is still running after `waitTimeoutMs` (5 minutes by default) is returned with its job ID and status `processing`, so the agent can check it later with `checkGenerationJob`.
- The API key is read from `EMPIRIOLABS_API_KEY` (or the `apiKey` option), sent only to the configured base URL, never sent on a redirect, and never included in errors or results.
