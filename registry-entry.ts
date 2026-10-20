// Entry for the AI SDK tools registry: add the object below to the `tools` array
// in vercel/ai content/tools-registry/registry.ts, following
// https://github.com/vercel/ai/blob/main/contributing/add-new-tool-to-registry.md
// The Tool interface is copied from that file so the entry is type-checked here.
// This file is not part of the npm package.

export interface Tool {
  slug: string;
  name: string;
  description: string;
  packageName: string;
  tags?: string[];
  apiKeyEnvName?: string;
  installCommand: {
    pnpm: string;
    npm: string;
    yarn: string;
    bun: string;
  };
  codeExample: string;
  docsUrl?: string;
  apiKeyUrl?: string;
  websiteUrl?: string;
  npmUrl?: string;
}

export const empiriolabs: Tool = {
  slug: 'empiriolabs',
  name: 'EmpirioLabs AI',
  description:
    'Give agents image, video, and audio generation from the EmpirioLabs AI model catalog. The tools generate and edit images, generate videos from a prompt or a still image, turn text into speech, transcribe audio, check long-running generation jobs, and find models with their prices. Each generation is billed to your EmpirioLabs AI account at the model\'s listed price; the model finder is free.',
  packageName: '@empiriolabs/ai-sdk',
  tags: ['image-generation', 'video-generation', 'text-to-speech', 'transcription', 'media'],
  apiKeyEnvName: 'EMPIRIOLABS_API_KEY',
  installCommand: {
    pnpm: 'pnpm add @empiriolabs/ai-sdk ai zod',
    npm: 'npm install @empiriolabs/ai-sdk ai zod',
    yarn: 'yarn add @empiriolabs/ai-sdk ai zod',
    bun: 'bun add @empiriolabs/ai-sdk ai zod',
  },
  codeExample: `import { generateText, isStepCount } from 'ai';
import { empiriolabsTools } from '@empiriolabs/ai-sdk';

const { text } = await generateText({
  model: 'anthropic/claude-sonnet-5.5',
  prompt:
    'Find a cheap image model, then use it to generate one image of a lighthouse at dawn in watercolor. Reply with the image link.',
  tools: empiriolabsTools(),
  stopWhen: isStepCount(4),
});

console.log(text);`,
  docsUrl: 'https://docs.empiriolabs.ai/integrations#ai-sdk-tools',
  apiKeyUrl: 'https://platform.empiriolabs.ai/dashboard/api-keys',
  websiteUrl: 'https://empiriolabs.ai',
  npmUrl: 'https://www.npmjs.com/package/@empiriolabs/ai-sdk',
};
