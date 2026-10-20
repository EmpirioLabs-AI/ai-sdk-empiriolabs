/**
 * Unit tests never reach the network and never see a real API key: the global
 * fetch throws, EMPIRIOLABS_API_KEY is blank, and the catalog cache starts empty.
 */
import { afterEach, beforeEach, vi } from "vitest";
import { clearCatalogCache } from "../src/catalog.js";

beforeEach(() => {
  vi.stubEnv("EMPIRIOLABS_API_KEY", "");
  vi.stubGlobal("fetch", () => {
    throw new Error("Unit tests must not use the network; pass a fetch double.");
  });
  clearCatalogCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
