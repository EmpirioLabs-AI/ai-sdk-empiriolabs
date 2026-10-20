/** Keeps package.json, the runtime constants, the docs, and the published files consistent. */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { empiriolabs as registryEntry } from "../registry-entry.js";
import { PACKAGE_NAME } from "../src/constants.js";
import { API_KEY_ENV_VAR, DEFAULT_BASE_URL, PACKAGE_VERSION, empiriolabsTools } from "../src/index.js";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));

function sourceFiles(dir: string): string[] {
  return readdirSync(new URL(dir, root), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(`${dir}${entry.name}/`) : entry.name.endsWith(".ts") ? [`${dir}${entry.name}`] : [],
  );
}

describe("package metadata", () => {
  it("matches the runtime constants and the release contract", () => {
    expect(pkg.name).toBe(PACKAGE_NAME);
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect(pkg.license).toBe("MIT");
    expect(pkg.type).toBe("module");
    expect(pkg.exports["."]).toEqual({ types: "./dist/index.d.ts", default: "./dist/index.js" });
    expect(pkg.homepage).toBe("https://empiriolabs.ai");
    expect(pkg.repository).toEqual({ type: "git", url: "git+https://github.com/EmpirioLabs-AI/ai-sdk-empiriolabs.git" });
    expect(pkg.bugs.url).toBe("https://github.com/EmpirioLabs-AI/ai-sdk-empiriolabs/issues");
    expect(pkg.author).toEqual({ name: "EmpirioLabs AI", email: "support@empiriolabs.ai", url: "https://empiriolabs.ai" });
    expect(pkg.publishConfig.access).toBe("public");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.keywords).toEqual(
      expect.arrayContaining([
        "ai-sdk",
        "vercel-ai",
        "ai-sdk-tools",
        "empiriolabs",
        "image-generation",
        "video-generation",
        "text-to-speech",
        "transcription",
        "agents",
      ]),
    );
  });

  it("has no runtime dependencies and takes AI SDK 7 and Zod as peers", () => {
    expect(pkg.dependencies ?? {}).toEqual({});
    expect(pkg.peerDependencies).toEqual({ ai: "^7.0.0", zod: "^3.25.76 || ^4.1.8" });
    expect(pkg.devDependencies.ai).toMatch(/^7\./u);
  });

  it("publishes only the build, the README, the changelog, and the license", () => {
    expect(pkg.files).toEqual(["dist/**/*.js", "dist/**/*.d.ts", "README.md", "CHANGELOG.md", "LICENSE"]);
  });
});

describe("user-facing text", () => {
  const files = [
    "README.md",
    "CHANGELOG.md",
    "LICENSE",
    "package.json",
    "docs-snippet.mdx",
    "registry-entry.ts",
    ...sourceFiles("src/"),
  ];

  it("uses no em dash anywhere a reader or a model sees", () => {
    const emDash = String.fromCharCode(0x2014);
    for (const file of files) {
      expect(read(file), file).not.toContain(emDash);
    }
    for (const tool of Object.values(empiriolabsTools())) {
      expect(tool.description).not.toContain(emDash);
    }
  });

  it("names the legal entity in the license and the brand everywhere else", () => {
    expect(read("LICENSE")).toContain("Copyright (c) 2026 EmpirioLabs.ai LLC");
    for (const file of ["README.md", "docs-snippet.mdx"]) {
      expect(read(file), file).not.toContain("EmpirioLabs.ai LLC");
      expect(read(file), file).toContain("EmpirioLabs AI");
    }
  });

  it("describes the platform with the approved sentence", () => {
    expect(read("README.md")).toContain(
      "EmpirioLabs AI is a specialized AI inference and integration provider. It self-hosts open-source models on GPU " +
        "infrastructure it manages, runs optimized endpoints for proprietary models, and offers on-demand GPU Cloud " +
        "instances and hosted AI agents.",
    );
  });

  it("documents this version, the defaults, and the links", () => {
    expect(read("CHANGELOG.md")).toContain(`## ${PACKAGE_VERSION}`);
    const readme = read("README.md");
    expect(readme).toContain(DEFAULT_BASE_URL);
    expect(readme).toContain("npm install @empiriolabs/ai-sdk ai zod");
    for (const link of [
      "https://empiriolabs.ai",
      "https://docs.empiriolabs.ai",
      "https://platform.empiriolabs.ai/dashboard/api-keys",
      "https://empiriolabs.ai/pricing",
      "support@empiriolabs.ai",
    ]) {
      expect(readme).toContain(link);
    }
  });

  it("shows the agent call that the live smoke test runs", () => {
    const readme = read("README.md");
    const live = read("test/smoke.live.test.ts");
    const prompt =
      "Find a cheap image model, then use it to generate one image of a lighthouse at dawn in watercolor. ";
    for (const text of [readme, live, read("docs-snippet.mdx")]) {
      expect(text).toContain(prompt);
      expect(text).toContain("stopWhen: isStepCount(4)");
    }
    expect(readme).toContain("empiriolabs('qwen3-8-flash')");
    expect(live).toContain('|| "qwen3-8-flash"');
  });
});

describe("tool descriptions", () => {
  const tools = empiriolabsTools();

  it("say what is billed, that findModels is free, and that links expire", () => {
    for (const tool of [tools.generateImage, tools.generateVideo, tools.textToSpeech, tools.transcribeAudio]) {
      expect(tool.description).toMatch(/billed to the user's EmpirioLabs AI account/iu);
      expect(tool.description).toContain("findModels, which is free");
    }
    for (const tool of [tools.generateImage, tools.generateVideo, tools.textToSpeech, tools.checkGenerationJob]) {
      expect(tool.description).toMatch(/signed and expire/u);
    }
    expect(tools.findModels.description).toContain("Free: nothing is billed.");
  });

  it("are the six tools, with per-tool default models", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "checkGenerationJob",
      "findModels",
      "generateImage",
      "generateVideo",
      "textToSpeech",
      "transcribeAudio",
    ]);
    const configured = empiriolabsTools({ models: { image: "image-a", video: "video-b", speech: "voice-c", transcription: "stt-d" } });
    expect(configured.generateImage.description).toContain("When model is omitted, image-a is used.");
    expect(configured.generateVideo.description).toContain("When model is omitted, video-b is used.");
    expect(configured.textToSpeech.description).toContain("When model is omitted, voice-c is used.");
    expect(configured.transcribeAudio.description).toContain("When model is omitted, stt-d is used.");
  });

  it("reject a bad wait limit when they are created", () => {
    expect(() => empiriolabsTools({ waitTimeoutMs: -1 })).toThrow(/waitTimeoutMs/u);
    expect(() => empiriolabsTools({ waitTimeoutMs: Number.NaN })).toThrow(/waitTimeoutMs/u);
  });
});

describe("registry entry", () => {
  it("matches the package and the registry's conventions", () => {
    expect(registryEntry.slug).toBe("empiriolabs");
    expect(registryEntry.name).toBe("EmpirioLabs AI");
    expect(registryEntry.packageName).toBe(pkg.name);
    expect(registryEntry.apiKeyEnvName).toBe(API_KEY_ENV_VAR);
    expect(registryEntry.installCommand).toEqual({
      pnpm: `pnpm add ${pkg.name} ai zod`,
      npm: `npm install ${pkg.name} ai zod`,
      yarn: `yarn add ${pkg.name} ai zod`,
      bun: `bun add ${pkg.name} ai zod`,
    });
    expect(registryEntry.codeExample).toContain("import { generateText, isStepCount } from 'ai';");
    expect(registryEntry.codeExample).toContain(`import { empiriolabsTools } from '${pkg.name}';`);
    expect(registryEntry.codeExample).toContain("model: 'anthropic/claude-sonnet-5.5'");
    expect(registryEntry.docsUrl).toBe("https://docs.empiriolabs.ai/integrations#ai-sdk-tools");
    expect(registryEntry.apiKeyUrl).toBe("https://platform.empiriolabs.ai/dashboard/api-keys");
    expect(registryEntry.websiteUrl).toBe("https://empiriolabs.ai");
    expect(registryEntry.npmUrl).toBe(`https://www.npmjs.com/package/${pkg.name}`);
  });
});
