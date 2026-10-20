/** The error type every tool throws, and the redaction applied to every message. */

export type EmpirioLabsErrorDetails = {
  /** HTTP status of the API response, when the API answered. */
  status?: number;
  /** Machine-readable code from the API error, or one of this package's codes. */
  code?: string;
  /** Error type from the API error, when it sent one. */
  type?: string;
  /** The generation job the error belongs to, when there is one. */
  jobId?: string;
};

/**
 * A request to EmpirioLabs AI failed. The message is the API's own message (or a
 * description of the network failure) and never contains the API key.
 */
export class EmpirioLabsError extends Error {
  readonly status: number | undefined;
  readonly code: string | undefined;
  readonly type: string | undefined;
  readonly jobId: string | undefined;

  constructor(message: string, details: EmpirioLabsErrorDetails = {}) {
    super(message);
    this.name = "EmpirioLabsError";
    this.status = details.status;
    this.code = details.code;
    this.type = details.type;
    this.jobId = details.jobId;
  }
}

const KEY_SHAPE = /sk-empiriolabs-[A-Za-z0-9_-]+/gu;

/** Removes the given secrets, and anything shaped like an EmpirioLabs AI key, from text. */
export function redact(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
  let out = text;
  for (const secret of secrets) {
    const value = secret?.trim();
    if (value && value.length >= 8) {
      out = out.split(value).join("[redacted]");
    }
  }
  return out.replace(KEY_SHAPE, "sk-empiriolabs-[redacted]");
}

/** The reason an aborted signal carries, or a standard AbortError. */
export function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}
