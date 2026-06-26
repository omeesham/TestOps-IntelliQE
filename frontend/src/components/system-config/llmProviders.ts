/**
 * LLM provider registry — the single source of truth for the LLM Configuration
 * page. Adding a new provider is purely declarative: append an entry here and
 * the page renders its card, configuration fields, and status without any
 * layout changes. The backend connection-test / model-listing endpoints key off
 * `id`, so keep ids aligned with the server's provider switch.
 */

export type LLMProviderStatus = 'available' | 'coming-soon';

export interface LLMFieldDef {
  /** Stored on the provider config under this key (top-level). */
  key: 'endpoint' | 'orgId' | 'projectId';
  label: string;
  placeholder: string;
  required?: boolean;
  help?: string;
}

export interface LLMProviderDef {
  /** Stable id → integration row `llm-<id>-<env>`. Never rename once shipped. */
  id: string;
  name: string;
  tagline: string;
  /** Avatar initials + accent colour (brand-aligned, used only for the chip). */
  initials: string;
  accent: string;
  status: LLMProviderStatus;
  /** Self-hosted / local providers need no API key. */
  keyless?: boolean;
  apiKeyLabel: string;
  apiKeyPlaceholder: string;
  apiKeyHelp?: string;
  /** API endpoint — shown for every provider, pre-filled, override-able. */
  defaultEndpoint: string;
  /** Extra credential/config fields beyond the API key + endpoint. */
  fields: LLMFieldDef[];
  /** Shown before a live connection is made / as a fallback. */
  fallbackModels: string[];
  docsUrl?: string;
}

export const LLM_PROVIDERS: LLMProviderDef[] = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    tagline: 'Claude Opus, Sonnet & Haiku — the platform default engine.',
    initials: 'AC',
    accent: '#CC785C',
    status: 'available',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'sk-ant-api03-…',
    apiKeyHelp: 'Create one at console.anthropic.com → API Keys.',
    defaultEndpoint: 'https://api.anthropic.com',
    fields: [],
    fallbackModels: ['claude-opus-4-8', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
    docsUrl: 'https://docs.anthropic.com',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    tagline: 'Gemini 2.0 / 1.5 multimodal models via Google AI.',
    initials: 'GG',
    accent: '#4285F4',
    status: 'available',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'AIza…',
    apiKeyHelp: 'Generate a key in Google AI Studio.',
    defaultEndpoint: 'https://generativelanguage.googleapis.com',
    fields: [],
    fallbackModels: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
    docsUrl: 'https://ai.google.dev',
  },
  {
    id: 'openai',
    name: 'OpenAI ChatGPT',
    tagline: 'GPT-4o and o-series reasoning models.',
    initials: 'OA',
    accent: '#10A37F',
    status: 'available',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'sk-…',
    apiKeyHelp: 'Create a secret key at platform.openai.com → API keys.',
    defaultEndpoint: 'https://api.openai.com/v1',
    fields: [
      { key: 'orgId', label: 'Organization ID', placeholder: 'org-… (optional)', help: 'Only required for multi-org accounts.' },
    ],
    fallbackModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'o1', 'o1-mini'],
    docsUrl: 'https://platform.openai.com/docs',
  },
  // ── Future providers — extensible, no layout change required ──
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    tagline: 'Enterprise OpenAI models on Microsoft Azure.',
    initials: 'AZ',
    accent: '#0078D4',
    status: 'coming-soon',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Azure OpenAI resource key',
    defaultEndpoint: 'https://your-resource.openai.azure.com',
    fields: [
      { key: 'projectId', label: 'Deployment Name', placeholder: 'gpt-4o-deployment', required: true },
    ],
    fallbackModels: ['gpt-4o', 'gpt-4-turbo', 'gpt-35-turbo'],
  },
  {
    id: 'aws-bedrock',
    name: 'AWS Bedrock',
    tagline: 'Foundation models via Amazon Bedrock.',
    initials: 'BR',
    accent: '#FF9900',
    status: 'coming-soon',
    apiKeyLabel: 'Access Key',
    apiKeyPlaceholder: 'AKIA…',
    defaultEndpoint: 'https://bedrock-runtime.us-east-1.amazonaws.com',
    fields: [
      { key: 'projectId', label: 'AWS Region', placeholder: 'us-east-1', required: true },
    ],
    fallbackModels: ['anthropic.claude-3-5-sonnet-20241022-v2:0', 'anthropic.claude-3-haiku-20240307-v1:0'],
  },
  {
    id: 'mistral',
    name: 'Mistral AI',
    tagline: 'Open-weight European frontier models.',
    initials: 'MI',
    accent: '#FA520F',
    status: 'coming-soon',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Mistral API key',
    defaultEndpoint: 'https://api.mistral.ai/v1',
    fields: [],
    fallbackModels: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
  },
  {
    id: 'cohere',
    name: 'Cohere',
    tagline: 'Command R+ retrieval-optimised models.',
    initials: 'CO',
    accent: '#39594D',
    status: 'coming-soon',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Cohere API key',
    defaultEndpoint: 'https://api.cohere.com',
    fields: [],
    fallbackModels: ['command-r-plus', 'command-r', 'command'],
  },
  {
    id: 'groq',
    name: 'Groq',
    tagline: 'Ultra-low-latency inference on LPU hardware.',
    initials: 'GQ',
    accent: '#F55036',
    status: 'coming-soon',
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'gsk_…',
    defaultEndpoint: 'https://api.groq.com/openai/v1',
    fields: [],
    fallbackModels: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
  },
  {
    id: 'ollama',
    name: 'Ollama (Self-hosted)',
    tagline: 'Run local / private LLMs on your own infrastructure.',
    initials: 'OL',
    accent: '#111827',
    status: 'coming-soon',
    keyless: true,
    apiKeyLabel: 'API Key',
    apiKeyPlaceholder: 'Not required for local Ollama',
    defaultEndpoint: 'http://localhost:11434',
    fields: [],
    fallbackModels: ['llama3.2', 'llama3.1', 'mistral', 'qwen2.5'],
  },
];

export function getProvider(id: string): LLMProviderDef | undefined {
  return LLM_PROVIDERS.find((p) => p.id === id);
}

/** Integration-config row id for a provider in a given environment. */
export function providerRowId(providerId: string, env: LLMEnvironment): string {
  return `llm-${providerId}-${env}`;
}

export const LLM_SETTINGS_ID = 'llm-settings';

export type LLMEnvironment = 'development' | 'qa' | 'production';

export const LLM_ENVIRONMENTS: { value: LLMEnvironment; label: string; short: string }[] = [
  { value: 'development', label: 'Development', short: 'DEV' },
  { value: 'qa', label: 'QA', short: 'QA' },
  { value: 'production', label: 'Production', short: 'PROD' },
];
