/** Input schema pieces shared by the tools. */
import { z } from "zod/v4";

/** An https URL that the API can fetch. */
export const httpsUrl = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}, "Must be a public https URL.");

export const modelIdSchema = z.string().trim().min(1).max(200);
