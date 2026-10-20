/** Identity, endpoints, and defaults of the EmpirioLabs AI API. */

export const PACKAGE_NAME = "@empiriolabs/ai-sdk";
/** Kept equal to package.json "version"; a unit test enforces it. */
export const PACKAGE_VERSION = "0.1.1";
export const USER_AGENT = `${PACKAGE_NAME}/${PACKAGE_VERSION}`;

export const BRAND = "EmpirioLabs AI";

/** OpenAI-compatible API root, including the version segment. */
export const DEFAULT_BASE_URL = "https://api.empiriolabs.ai/v1";
export const API_KEY_ENV_VAR = "EMPIRIOLABS_API_KEY";

export const API_KEYS_URL = "https://platform.empiriolabs.ai/dashboard/api-keys";
export const BILLING_URL = "https://platform.empiriolabs.ai/dashboard/billing";
export const PRICING_URL = "https://empiriolabs.ai/pricing";

/** How long a tool waits for a queued job before it returns the job ID instead. */
export const DEFAULT_WAIT_TIMEOUT_MS = 300_000;
/** How long the public model catalog is reused before it is read again. */
export const CATALOG_CACHE_TTL_MS = 5 * 60_000;

/** Job polling: the first delay, the growth factor, and the longest delay. */
export const POLL_INITIAL_DELAY_MS = 2_000;
export const POLL_BACKOFF_FACTOR = 1.5;
export const POLL_MAX_DELAY_MS = 10_000;

/** Catalog `supported_endpoints` values the tools call or look for. */
export const ENDPOINTS = {
  chat: "POST /v1/chat/completions",
  image: "POST /v1/images/generations",
  video: "POST /v1/videos/generations",
  speech: "POST /v1/audio/speech",
  transcription: "POST /v1/audio/transcriptions",
  embedding: "POST /v1/embeddings",
} as const;

/** Said in every tool result that carries generated file links. */
export const EXPIRING_LINKS_NOTE =
  "These links are signed and expire. Download any file you want to keep.";
