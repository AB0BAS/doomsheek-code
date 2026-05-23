const PROVIDERS = {
  openai: {
    name: 'OpenAI',
    type: 'openai',
    baseURL: 'https://api.openai.com/v1',
    validate: { method: 'GET', path: '/models' },
    // Актуальные модели на 2026. После проверки ключа полный список придёт из /v1/models.
    models: [
      // Передовая линейка GPT-5.x
      'gpt-5.5',
      'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano',
      'gpt-5.2', 'gpt-5.1', 'gpt-5-mini',
      // Codex (для кода)
      'codex-5.3', 'codex-5.2', 'codex-5.1-max', 'codex-5.1-mini',
      // Reasoning o-серии
      'o3', 'o4-mini',
      // Legacy
      'gpt-4o', 'gpt-4o-mini',
      'gpt-4.1', 'gpt-4', 'gpt-3.5-turbo'
    ],
    keyHint: 'sk-...'
  },
  anthropic: {
    name: 'Anthropic',
    type: 'anthropic',
    baseURL: 'https://api.anthropic.com/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-3-5-sonnet-latest', 'claude-3-5-haiku-latest'],
    keyHint: 'sk-ant-...'
  },
  gemini: {
    name: 'Google Gemini',
    type: 'gemini',
    authMode: 'apikey', // ключ AIza... → x-goog-api-key
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    validate: { method: 'GET', path: '/models' },
    // Курируемые актуальные модели. Полный список доступен через тоггл «Показать все».
    models: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    keyHint: 'AIza...'
  },
  geminiOAuth: {
    name: 'Google Gemini (OAuth)',
    type: 'gemini',
    authMode: 'oauth', // токен ya29.../AQ.Ab8R... → Authorization: Bearer
    baseURL: 'https://generativelanguage.googleapis.com/v1beta',
    validate: { method: 'GET', path: '/models' },
    models: ['gemini-3.1-pro', 'gemini-3-flash', 'gemini-3.5-flash', 'gemini-2.5-flash'],
    keyHint: 'ya29... / AQ.Ab8R...'
  },
  openrouter: {
    name: 'OpenRouter',
    type: 'openai',
    baseURL: 'https://openrouter.ai/api/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet', 'google/gemini-pro-1.5', 'meta-llama/llama-3.1-405b-instruct', 'deepseek/deepseek-chat'],
    keyHint: 'sk-or-...'
  },
  xai: {
    name: 'xAI (Grok)',
    type: 'openai',
    baseURL: 'https://api.x.ai/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['grok-2-latest', 'grok-2-vision-latest', 'grok-beta'],
    keyHint: 'xai-...'
  },
  mistral: {
    name: 'Mistral AI',
    type: 'openai',
    baseURL: 'https://api.mistral.ai/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['mistral-large-latest', 'mistral-medium-latest', 'mistral-small-latest', 'codestral-latest', 'open-mistral-nemo'],
    keyHint: '...'
  },
  groq: {
    name: 'Groq',
    type: 'openai',
    baseURL: 'https://api.groq.com/openai/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['llama-3.3-70b-versatile', 'llama-3.1-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768', 'gemma2-9b-it'],
    keyHint: 'gsk_...'
  },
  deepinfra: {
    name: 'DeepInfra',
    type: 'openai',
    baseURL: 'https://api.deepinfra.com/v1/openai',
    validate: { method: 'GET', path: '/models' },
    models: ['meta-llama/Meta-Llama-3.1-405B-Instruct', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'mistralai/Mixtral-8x22B-Instruct-v0.1'],
    keyHint: '...'
  },
  together: {
    name: 'Together AI',
    type: 'openai',
    baseURL: 'https://api.together.xyz/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo', 'meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo', 'deepseek-ai/DeepSeek-V3'],
    keyHint: '...'
  },
  cerebras: {
    name: 'Cerebras',
    type: 'openai',
    baseURL: 'https://api.cerebras.ai/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['llama3.1-70b', 'llama3.1-8b', 'llama-3.3-70b'],
    keyHint: 'csk-...'
  },
  cohere: {
    name: 'Cohere',
    type: 'cohere',
    baseURL: 'https://api.cohere.com/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['command-r-plus', 'command-r', 'command-r7b-12-2024', 'command-light'],
    keyHint: '...'
  },
  perplexity: {
    name: 'Perplexity',
    type: 'openai',
    baseURL: 'https://api.perplexity.ai',
    validate: { method: 'POST', path: '/chat/completions', validateBody: { model: 'sonar', messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 } },
    models: ['sonar', 'sonar-pro', 'sonar-reasoning', 'sonar-reasoning-pro'],
    keyHint: 'pplx-...'
  },
  deepseek: {
    name: 'DeepSeek',
    type: 'openai',
    baseURL: 'https://api.deepseek.com/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder'],
    keyHint: 'sk-...'
  },
  alibaba: {
    name: 'Alibaba (Qwen)',
    type: 'openai',
    baseURL: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['qwen-max', 'qwen-plus', 'qwen-turbo', 'qwen2.5-72b-instruct', 'qwen2.5-coder-32b-instruct'],
    keyHint: 'sk-...'
  },
  nvidia: {
    name: 'NVIDIA NIM',
    type: 'openai',
    baseURL: 'https://integrate.api.nvidia.com/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['meta/llama-3.1-405b-instruct', 'meta/llama-3.1-70b-instruct', 'mistralai/mixtral-8x22b-instruct-v0.1', 'nvidia/nemotron-4-340b-instruct'],
    keyHint: 'nvapi-...'
  },
  nebius: {
    name: 'Nebius AI',
    type: 'openai',
    baseURL: 'https://api.studio.nebius.com/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['meta-llama/Meta-Llama-3.1-405B-Instruct', 'meta-llama/Meta-Llama-3.1-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct'],
    keyHint: '...'
  },
  huggingface: {
    name: 'HuggingFace',
    type: 'hf',
    baseURL: 'https://api-inference.huggingface.co',
    validate: { method: 'GET', path: 'https://huggingface.co/api/whoami-v2', absolute: true },
    models: ['meta-llama/Meta-Llama-3.1-70B-Instruct', 'mistralai/Mixtral-8x7B-Instruct-v0.1', 'Qwen/Qwen2.5-72B-Instruct'],
    keyHint: 'hf_...'
  },
  fireworks: {
    name: 'Fireworks AI',
    type: 'openai',
    baseURL: 'https://api.fireworks.ai/inference/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['accounts/fireworks/models/llama-v3p1-405b-instruct', 'accounts/fireworks/models/llama-v3p1-70b-instruct', 'accounts/fireworks/models/deepseek-v3', 'accounts/fireworks/models/qwen2p5-72b-instruct'],
    keyHint: 'fw_...'
  },
  azure: {
    name: 'Azure OpenAI',
    type: 'azure',
    baseURL: '',
    customFields: [
      { id: 'endpoint', label: 'Endpoint (https://YOUR.openai.azure.com)', placeholder: 'https://your-resource.openai.azure.com' },
      { id: 'deployment', label: 'Deployment name', placeholder: 'gpt-4o' },
      { id: 'apiVersion', label: 'API version', placeholder: '2024-08-01-preview' }
    ],
    models: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
    keyHint: '...'
  },
  kilo: {
    name: 'Kilo Gateway',
    type: 'openai',
    baseURL: 'https://kilocode.ai/api/openrouter',
    customFields: [
      { id: 'baseURL', label: 'Base URL (override)', placeholder: 'https://kilocode.ai/api/openrouter' }
    ],
    validate: { method: 'GET', path: '/models' },
    models: ['openai/gpt-4o', 'anthropic/claude-3.5-sonnet'],
    keyHint: '...'
  },
  venice: {
    name: 'Venice AI',
    type: 'openai',
    baseURL: 'https://api.venice.ai/api/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['llama-3.3-70b', 'llama-3.1-405b', 'qwen-2.5-coder-32b', 'dolphin-2.9.2-qwen2-72b'],
    keyHint: '...'
  },
  inference: {
    name: 'Inference.net',
    type: 'openai',
    baseURL: 'https://api.inference.net/v1',
    validate: { method: 'GET', path: '/models' },
    models: ['meta-llama/llama-3.1-70b-instruct/fp-16', 'meta-llama/llama-3.1-8b-instruct/fp-16', 'qwen/qwen-2.5-72b-instruct/fp-16'],
    keyHint: '...'
  }
};

const PROVIDER_IDS = Object.keys(PROVIDERS);

module.exports = { PROVIDERS, PROVIDER_IDS };
