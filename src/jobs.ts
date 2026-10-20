/** Reads and waits for EmpirioLabs AI generation jobs (`GET /v1/jobs/{job_id}`). */
import { POLL_BACKOFF_FACTOR, POLL_INITIAL_DELAY_MS, POLL_MAX_DELAY_MS } from "./constants.js";
import { EmpirioLabsError } from "./errors.js";
import { type ApiClient, isRecord, sleep } from "./http.js";
import { JOB_FAILED, JOB_SUCCEEDED } from "./media.js";

export type JobRecord = Record<string, unknown>;
export type JobState = "processing" | "completed" | "failed";

/** Job IDs are UUIDs or similar tokens; anything else never reaches a URL path. */
export const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;

export function assertJobId(jobId: string): string {
  const value = jobId.trim();
  if (!JOB_ID_PATTERN.test(value)) {
    throw new EmpirioLabsError("jobId must be the job ID returned by an EmpirioLabs AI tool.", {
      code: "invalid_job_id",
    });
  }
  return value;
}

export function jobStatus(job: JobRecord): string {
  return typeof job.status === "string" ? job.status.trim().toLowerCase() : "";
}

/** Completed and failed are final; every other status, known or not, is still running. */
export function jobState(status: string): JobState {
  if (JOB_SUCCEEDED.has(status)) {
    return "completed";
  }
  if (JOB_FAILED.has(status)) {
    return "failed";
  }
  return "processing";
}


/** The error message, code, and type of a failed job. */
export function jobError(job: JobRecord): { message?: string; code?: string; type?: string } {
  const error = job.error;
  if (typeof error === "string" && error.trim()) {
    return { message: error.trim() };
  }
  if (!isRecord(error)) {
    return {};
  }
  const inner = isRecord(error.error) ? error.error : error;
  const message = typeof inner.message === "string" && inner.message.trim() ? inner.message.trim() : undefined;
  const code = typeof inner.code === "string" || typeof inner.code === "number" ? String(inner.code) : undefined;
  const type = typeof inner.type === "string" ? inner.type : undefined;
  return { ...(message ? { message } : {}), ...(code ? { code } : {}), ...(type ? { type } : {}) };
}

export async function fetchJob(client: ApiClient, jobId: string, signal?: AbortSignal): Promise<JobRecord> {
  const job = await client.getJson<unknown>(`/jobs/${encodeURIComponent(assertJobId(jobId))}`, {
    auth: true,
    signal,
    timeoutMs: 60_000,
  });
  if (!isRecord(job)) {
    throw new EmpirioLabsError("EmpirioLabs AI returned a job in an unexpected format.", {
      code: "invalid_response",
      jobId,
    });
  }
  return job;
}

export type WaitOutcome =
  | { state: "completed"; status: string; job: JobRecord }
  | { state: "processing"; status: string; job: JobRecord };

/**
 * Polls a job until it finishes or `timeoutMs` runs out. The first check is
 * immediate; the delay between checks starts at 2 s and grows by half each
 * time up to 10 s. A failed job throws with the job's own error message.
 */
export async function waitForJob(
  client: ApiClient,
  jobId: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined; label: string },
): Promise<WaitOutcome> {
  const started = Date.now();
  let delay = POLL_INITIAL_DELAY_MS;
  for (;;) {
    const job = await fetchJob(client, jobId, options.signal);
    const status = jobStatus(job);
    const state = jobState(status);
    if (state === "completed") {
      return { state, status, job };
    }
    if (state === "failed") {
      const { message, code, type } = jobError(job);
      throw new EmpirioLabsError(
        client.redact(`${options.label} ${jobId} ${status}: ${message ?? "no details were returned"}`),
        { jobId, ...(code ? { code } : {}), ...(type ? { type } : {}) },
      );
    }
    const waited = Date.now() - started;
    if (waited + delay > options.timeoutMs) {
      return { state: "processing", status, job };
    }
    await sleep(delay, options.signal);
    delay = Math.min(delay * POLL_BACKOFF_FACTOR, POLL_MAX_DELAY_MS);
  }
}
