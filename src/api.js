const { PROVIDERS } = require('./providers');

function buildAuthHeaders(provider, key, extras = {}) {
  switch (provider.type) {
    case 'openai':
      return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    case 'anthropic':
      return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' };
    case 'gemini':
      return { 'Content-Type': 'application/json' };
    case 'cohere':
      return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    case 'hf':
      return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
    case 'azure':
      return { 'api-key': key, 'Content-Type': 'application/json' };
    default:
      return { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' };
  }
}

function resolveBaseURL(provider, extras = {}) {
  if (provider.type === 'azure') {
    const ep = (extras.endpoint || '').replace(/\/$/, '');
    return ep;
  }
  if (extras.baseURL) return extras.baseURL.replace(/\/$/, '');
  return provider.baseURL.replace(/\/$/, '');
}

// ====================================================================
// Универсальный чекер API ключей (Улучшенная версия, порт с Python).
// Проверяет ключи через легковесные эндпоинты, а в случае спорных
// ответов (ложные 429/403) использует микро-тесты с глубоким анализом
// тела ответа (проверка на баланс и квоты).
// ====================================================================

const _TIMEOUT_MS = 15000;

async function checkKey({ providerId, key, extras = {} }) {
  const provider = PROVIDERS[providerId];
  if (!provider) {
    return { ok: false, error: `Неизвестный провайдер: ${providerId}`, models: [], info: null };
  }
  // Триммим — пользователь часто вставляет ключ с пробелами/переводами строк, и URL ломается.
  key = typeof key === 'string' ? key.trim() : key;
  if (!key && provider.type !== 'azure') {
    return { ok: false, error: 'Введите API-ключ', models: [], info: null };
  }
  const baseURL = resolveBaseURL(provider, extras) || provider.baseURL;
  if (!baseURL && provider.type !== 'azure') {
    return { ok: false, error: 'Требуется указать base_url (например для Azure)', models: [], info: null };
  }

  if (providerId === 'anthropic')   return _checkAnthropic(key, provider, baseURL);
  if (provider.type === 'gemini')   return _checkGemini(key, provider, baseURL);
  if (providerId === 'huggingface') return _checkHuggingface(key);
  if (providerId === 'cohere')      return _checkCohere(key, provider, baseURL);
  if (provider.type === 'azure')    return _checkAzure(key, extras);
  return _checkOpenaiCompatible(key, provider, baseURL, providerId);
}

// --- общие хелперы ---------------------------------------------------

function _withTimeout(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

async function _safeReadBody(res) {
  try { return await res.text(); } catch { return ''; }
}

function _extractErrorMessage(body) {
  if (!body) return '';
  try {
    const data = JSON.parse(body);
    if (data?.error?.message) return String(data.error.message).slice(0, 150);
    if (typeof data?.error === 'string') return data.error.slice(0, 150);
    if (data?.message) return String(data.message).slice(0, 150);
    if (Array.isArray(data) && data[0]?.message) return String(data[0].message).slice(0, 150);
  } catch {}
  return body.slice(0, 100);
}

function _extractModels(data, providerId) {
  const models = [];
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    if (Array.isArray(data.data)) {
      for (const m of data.data) {
        if (m && typeof m === 'object' && m.id) models.push(m.id);
        else if (typeof m === 'string') models.push(m);
      }
    } else if (Array.isArray(data.models)) {
      for (const m of data.models) {
        if (m && typeof m === 'object') {
          const id = m.id || m.name || '';
          if (id) models.push(id);
        } else if (typeof m === 'string') {
          models.push(m);
        }
      }
    }
  }
  // Никакой фильтрации — отдаём всё, что вернул провайдер (отсортировано).
  return models.filter(Boolean).sort();
}

// --- OpenAI-совместимый /v1/models -----------------------------------

async function _checkOpenaiCompatible(apiKey, provider, baseURL, providerId) {
  const result = { ok: false, models: [], error: null, info: null };
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Accept': 'application/json',
  };
  const validatePath = provider.validate?.path || '/models';
  const url = `${baseURL.replace(/\/$/, '')}${validatePath}`;
  const { signal, cancel } = _withTimeout(_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal });
    cancel();
    const status = res.status;
    const body = await _safeReadBody(res);
    const errMsg = _extractErrorMessage(body);
    const lower = body.toLowerCase();

    // Проверяем на пустой баланс сразу по тексту ошибки.
    if (lower.includes('insufficient_quota') || lower.includes('billing_not_active')) {
      result.error = 'Закончился баланс / Нет квоты (insufficient_quota)';
      return result;
    }

    if (status === 200) {
      result.ok = true;
      try {
        const data = JSON.parse(body);
        const models = _extractModels(data, providerId);
        result.models = models;
        result.info = `Доступно моделей: ${models.length}`;
      } catch {
        result.info = 'Ключ валидный (200 OK)';
      }
      // Если это оригинальный OpenAI — попробуем стянуть точный баланс в $.
      if (providerId === 'openai') {
        const balance = await _checkOpenAIBalance(apiKey);
        if (balance) result.info = `${result.info || 'Ключ валидный'} | ${balance}`;
      }
      return result;
    }

    // Если поймали 429/403/401 на OpenAI — это может быть ложная тревога /models.
    if ((status === 429 || status === 403 || status === 401) && providerId === 'openai') {
      const fallback = await _openaiChatFallback(apiKey, baseURL);
      if (fallback) return fallback;
    }

    if (status === 401) {
      result.error = `Невалидный ключ (401): ${errMsg || 'Unauthorized'}`;
    } else if (status === 403) {
      if (['deepinfra', 'together', 'fireworks'].includes(providerId)) {
        result.ok = true;
        result.info = 'Ключ валидный, но метод /models закрыт провайдером';
      } else {
        result.error = `Доступ запрещён (403): ${errMsg || 'Forbidden'}`;
      }
    } else if (status === 429) {
      result.error = `Превышены лимиты запросов (429 Rate Limit): ${errMsg}`;
    } else if (status === 404) {
      result.error = 'Эндпоинт /models не найден. Неверный base_url.';
    } else {
      result.error = `HTTP ${status}: ${body.slice(0, 150)}`;
    }
    return result;
  } catch (e) {
    cancel();
    if (e?.name === 'AbortError') result.error = `Таймаут (${_TIMEOUT_MS / 1000}s) — сервер не отвечает`;
    else result.error = `Ошибка: ${(e?.message || String(e)).slice(0, 100)}`;
    return result;
  }
}

async function _openaiChatFallback(apiKey, baseURL) {
  // Резервный микро-запрос к OpenAI Chat Completions для точной проверки квоты.
  const url = `${baseURL.replace(/\/$/, '')}/chat/completions`;
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  const payload = {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: '.' }],
    max_tokens: 1
  };
  const { signal, cancel } = _withTimeout(10000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    cancel();
    const body = await _safeReadBody(res);
    const lower = body.toLowerCase();

    if (lower.includes('insufficient_quota') || lower.includes('billing_not_active')) {
      return {
        ok: false,
        models: [],
        error: 'Нет квоты / Баланс равен 0$ (insufficient_quota)',
        info: null,
      };
    }

    if (res.status === 200) {
      let info = 'Ключ рабочий (проверено через Chat Completions)';
      const balance = await _checkOpenAIBalance(apiKey);
      if (balance) info += ` | ${balance}`;
      return { ok: true, models: ['gpt-4o-mini (confirmed)'], error: null, info };
    }
    if (res.status === 429) {
      return {
        ok: true,
        models: [],
        error: null,
        info: 'Ключ валидный, но пойман жесткий IP/Rate Limit (429)',
      };
    }
  } catch {
    cancel();
  }
  return null;
}

async function _checkOpenAIBalance(apiKey) {
  // Попытка узнать точный баланс OpenAI в долларах через внутреннее API подписки.
  const headers = { 'Authorization': `Bearer ${apiKey}` };
  const urlSub = 'https://api.openai.com/v1/dashboard/billing/subscription';
  const { signal, cancel } = _withTimeout(5000);
  try {
    const resSub = await fetch(urlSub, { headers, signal });
    cancel();
    if (resSub.status === 200) {
      const data = await resSub.json();
      const totalGrant = Number(data?.hard_limit_usd ?? 0);
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, '0');
      const dd = String(now.getDate()).padStart(2, '0');
      const startDate = `${yyyy}-${mm}-01`;
      const endDate = `${yyyy}-${mm}-${dd}`;
      const urlUsage = `https://api.openai.com/v1/dashboard/billing/usage?start_date=${startDate}&end_date=${endDate}`;
      const t2 = _withTimeout(5000);
      try {
        const resUsage = await fetch(urlUsage, { headers, signal: t2.signal });
        t2.cancel();
        if (resUsage.status === 200) {
          const usageData = await resUsage.json();
          const totalUsed = Number(usageData?.total_usage ?? 0) / 100; // центы → доллары
          const remaining = Math.max(0, totalGrant - totalUsed);
          return `Баланс: ${remaining.toFixed(2)}$ из ${totalGrant.toFixed(2)}$`;
        }
      } catch { t2.cancel(); }
      return `Лимит аккаунта: ${totalGrant.toFixed(2)}$`;
    }
  } catch {
    cancel();
  }
  return null;
}

// --- Gemini ---------------------------------------------------------

// Заголовки авторизации для Gemini.
// authMode='apikey' (провайдер `gemini`)      → `x-goog-api-key: AIza...`
// authMode='oauth'  (провайдер `geminiOAuth`) → `Authorization: Bearer ya29.../AQ.Ab8R...`
// Если authMode не задан — авто-детект по формату ключа.
function _geminiAuthHeaders(key, extraHeaders = {}, authMode = null) {
  const headers = { ...extraHeaders };
  const trimmed = typeof key === 'string' ? key.trim() : '';
  if (!trimmed) return headers;
  let useBearer;
  if (authMode === 'oauth') useBearer = true;
  else if (authMode === 'apikey') useBearer = false;
  else useBearer = !/^AIza[0-9A-Za-z_\-]{20,}$/.test(trimmed);
  if (useBearer) headers['Authorization'] = `Bearer ${trimmed}`;
  else headers['x-goog-api-key'] = trimmed;
  return headers;
}

// Проверка по официальным признакам Google: status code field, reason, HTTP 429.
// Не используем «голое» вхождение слова "limit" — слишком широко (token limit, field limit и т.п.).
function _geminiIsQuota(body, status) {
  if (status === 429) return true;
  if (!body) return false;
  if (/RESOURCE_EXHAUSTED/i.test(body)) return true;
  if (/"reason"\s*:\s*"(RATE_LIMIT|QUOTA_EXCEEDED|RESOURCE_EXHAUSTED)"/i.test(body)) return true;
  if (/quota\s*(exceed|exhaust)/i.test(body)) return true;
  if (/rate[\s_-]?limit/i.test(body)) return true;
  return false;
}

function _geminiIsBadKey(body, status) {
  if (status === 401) return true;
  if (!body) return false;
  if (/API_KEY_INVALID/i.test(body)) return true;
  if (/API key not valid/i.test(body)) return true;
  if (/PERMISSION_DENIED/i.test(body) && status === 403) return true;
  return false;
}

async function _checkGemini(apiKey, provider, baseURL) {
  const result = { ok: false, models: [], error: null, info: null };
  const endpoint = provider.validate?.path || '/models';
  const url = `${baseURL.replace(/\/$/, '')}${endpoint}`;
  // Авторизация — по authMode из провайдера ('apikey' для AI Studio, 'oauth' для Bearer-токена).
  const headers = _geminiAuthHeaders(apiKey, { 'Accept': 'application/json' }, provider.authMode);
  const { signal, cancel } = _withTimeout(_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal });
    cancel();
    const status = res.status;
    const body = await _safeReadBody(res);

    if (status === 200) {
      result.ok = true;
      try {
        const data = JSON.parse(body);
        const arr = Array.isArray(data?.models) ? data.models : [];
        const models = arr
          .map(m => (m?.name || '').replace(/^models\//, ''))
          .filter(Boolean)
          .sort();
        result.models = models;
        result.info = `Доступно моделей: ${result.models.length}`;
      } catch {
        result.info = 'Ключ валидный (200 OK)';
      }
      return result;
    }

    // Сначала смотрим на жёсткие признаки невалидности — там fallback бесполезен.
    if (_geminiIsBadKey(body, status)) {
      result.error = `Невалидный API ключ Gemini: ${_extractErrorMessage(body) || 'API_KEY_INVALID'}`;
      return result;
    }
    if (_geminiIsQuota(body, status)) {
      result.error = 'Превышена квота аккаунта Gemini (RESOURCE_EXHAUSTED / rate limit)';
      return result;
    }

    // Иначе (502/503/неизвестно) — пробуем fallback через generateContent.
    const fallback = await _geminiGenerateFallback(apiKey, baseURL, provider.authMode);
    if (fallback) return fallback;

    result.error = `Ошибка ${status}: ${_extractErrorMessage(body) || 'неизвестно'}`;
    return result;
  } catch (e) {
    cancel();
    result.error = `Ошибка соединения: ${describeFetchError(e)}`;
    return result;
  }
}

async function _geminiGenerateFallback(apiKey, baseURL, authMode = null) {
  // Альтернативный микро-тест через реальную генерацию контента.
  // Пробуем несколько актуальных моделей — список Gemini быстро меняется,
  // и единственный жёсткий идентификатор может отвалиться 404'ом.
  const candidates = ['gemini-1.5-flash-latest', 'gemini-2.0-flash', 'gemini-1.5-flash'];
  const headers = _geminiAuthHeaders(apiKey, { 'Content-Type': 'application/json' }, authMode);
  const payload = JSON.stringify({ contents: [{ parts: [{ text: '.' }] }] });

  for (const modelName of candidates) {
    const url = `${baseURL.replace(/\/$/, '')}/models/${modelName}:generateContent`;
    const { signal, cancel } = _withTimeout(10000);
    try {
      const res = await fetch(url, { method: 'POST', headers, body: payload, signal });
      cancel();
      const body = await _safeReadBody(res);

      if (_geminiIsBadKey(body, res.status)) {
        return {
          ok: false,
          models: [],
          error: `Невалидный API ключ Gemini: ${_extractErrorMessage(body) || 'API_KEY_INVALID'}`,
          info: null,
        };
      }
      if (_geminiIsQuota(body, res.status)) {
        return {
          ok: false,
          models: [],
          error: 'Ключ неактивен: исчерпаны бесплатные или платные квоты проекта',
          info: null,
        };
      }
      if (res.status === 200) {
        return {
          ok: true,
          models: [`${modelName} (confirmed)`],
          error: null,
          info: `Ключ валидный! (Проверено через ${modelName})`,
        };
      }
      // 404 на эту модель — пробуем следующую.
    } catch {
      cancel();
    }
  }
  return null;
}

// --- Anthropic ------------------------------------------------------

async function _checkAnthropic(apiKey, provider, baseURL) {
  const result = { ok: false, models: [], error: null, info: null };
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'Accept': 'application/json',
  };
  const url = `${baseURL.replace(/\/$/, '')}/models`;
  const { signal, cancel } = _withTimeout(_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers, signal });
    cancel();
    const body = await _safeReadBody(res);

    if (res.status !== 200) {
      const lower = body.toLowerCase();
      if (lower.includes('credit') || lower.includes('quota')) {
        result.error = 'Закончился баланс Anthropic (Лимит квот)';
        return result;
      }
    }

    if (res.status === 200) {
      result.ok = true;
      try {
        const data = JSON.parse(body);
        const arr = Array.isArray(data?.data) ? data.data : [];
        const models = arr.map(m => m?.id).filter(Boolean).sort();
        result.models = models;
        result.info = `Доступно моделей: ${result.models.length}`;
      } catch {
        result.info = 'Ключ валидный (200 OK)';
      }
      return result;
    }

    if ([401, 403, 404, 429].includes(res.status)) {
      const fallback = await _checkAnthropicFallback(apiKey, baseURL);
      if (fallback) return fallback;
    }
    result.error = `HTTP ${res.status}: ${_extractErrorMessage(body)}`;
    return result;
  } catch (e) {
    cancel();
    result.error = (e?.message || String(e)).slice(0, 100);
    return result;
  }
}

async function _checkAnthropicFallback(apiKey, baseURL) {
  // Fallback через создание быстрого сообщения.
  const headers = {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  };
  const payload = {
    model: 'claude-3-5-sonnet-latest',
    max_tokens: 1,
    messages: [{ role: 'user', content: '.' }],
  };
  const url = `${baseURL.replace(/\/$/, '')}/messages`;
  const { signal, cancel } = _withTimeout(15000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal });
    cancel();
    const body = await _safeReadBody(res);
    const lower = body.toLowerCase();
    if (lower.includes('quota') || lower.includes('credit')) {
      return { ok: false, models: [], error: 'Закончился баланс аккаунта', info: null };
    }
    if (res.status === 200) {
      return { ok: true, models: [], error: null, info: 'Ключ валидный (через тестовый запуск messages)' };
    }
    if (res.status === 429) {
      return { ok: true, models: [], error: null, info: 'Ключ валидный (Пойман Rate-Limit)' };
    }
  } catch {
    cancel();
  }
  return null;
}

// --- HuggingFace ----------------------------------------------------

async function _checkHuggingface(apiKey) {
  const result = { ok: false, models: [], error: null, info: null };
  const url = 'https://huggingface.co/api/whoami-v2';
  const { signal, cancel } = _withTimeout(10000);
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, signal });
    cancel();
    if (res.status === 200) {
      try {
        const data = await res.json();
        result.ok = true;
        result.info = `Валидный токен. Юзер: ${data?.name || 'unknown'}`;
      } catch {
        result.ok = true;
        result.info = 'Ключ валидный';
      }
    } else {
      result.error = `Ошибка авторизации HF (${res.status})`;
    }
    return result;
  } catch (e) {
    cancel();
    result.error = (e?.message || String(e)).slice(0, 100);
    return result;
  }
}

// --- Cohere ---------------------------------------------------------

async function _checkCohere(apiKey, provider, baseURL) {
  const result = { ok: false, models: [], error: null, info: null };
  // Cohere /v2/models — у нас baseURL обычно с хвостом /v1, чистим, чтобы получить корень.
  const root = baseURL.replace(/\/$/, '').replace(/\/v1$/, '');
  const url = `${root}/v2/models`;
  const { signal, cancel } = _withTimeout(_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${apiKey}` }, signal });
    cancel();
    if (res.status === 200) {
      try {
        const data = await res.json();
        const arr = Array.isArray(data?.models) ? data.models : [];
        result.ok = true;
        result.models = arr.map(m => m?.name).filter(Boolean);
        result.info = `Доступно моделей: ${result.models.length}`;
      } catch {
        result.ok = true;
        result.info = 'Ключ валидный';
      }
    } else {
      result.error = `Ошибка Cohere API: ${res.status}`;
    }
    return result;
  } catch (e) {
    cancel();
    result.error = (e?.message || String(e)).slice(0, 100);
    return result;
  }
}

// --- Azure ----------------------------------------------------------

async function _checkAzure(apiKey, extras) {
  const result = { ok: false, models: [], error: null, info: null };
  const baseURL = (extras?.endpoint || '').replace(/\/$/, '');
  if (!baseURL) {
    result.error = 'Требуется Azure endpoint в custom_base_url';
    return result;
  }
  const ver = extras?.apiVersion || '2024-02-01';
  const url = `${baseURL}/openai/models?api-version=${encodeURIComponent(ver)}`;
  const { signal, cancel } = _withTimeout(15000);
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'api-key': apiKey }, signal });
    cancel();
    if (res.status === 200) {
      try {
        const data = await res.json();
        const arr = Array.isArray(data?.data) ? data.data : [];
        result.ok = true;
        result.models = arr.map(m => m?.id).filter(Boolean);
        result.info = `Доступно моделей: ${result.models.length}`;
      } catch {
        result.ok = true;
        result.info = 'Ключ валидный';
      }
    } else {
      result.error = `Azure отдал код ${res.status}`;
    }
    return result;
  } catch (e) {
    cancel();
    result.error = (e?.message || String(e)).slice(0, 100);
    return result;
  }
}

// ====================================================================
// Чат / стрим (без изменений).
// ====================================================================

function normalizeContent(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content ?? '') }];
}

function toOpenAIMessages(messages) {
  return messages.map((m) => {
    const parts = normalizeContent(m.content);
    const hasImage = parts.some(p => p.type === 'image');
    if (!hasImage) {
      return { role: m.role, content: parts.map(p => p.text).join('') };
    }
    return {
      role: m.role,
      content: parts.map(p => p.type === 'image'
        ? { type: 'image_url', image_url: { url: `data:${p.mimeType};base64,${p.data}` } }
        : { type: 'text', text: p.text })
    };
  });
}

function toAnthropicMessages(messages) {
  let system = '';
  const out = [];
  for (const m of messages) {
    const parts = normalizeContent(m.content);
    if (m.role === 'system') {
      const txt = parts.map(p => p.text || '').join('');
      system += (system ? '\n\n' : '') + txt;
    } else {
      const content = parts
        .map(p => p.type === 'image'
          ? { type: 'image', source: { type: 'base64', media_type: p.mimeType, data: p.data } }
          : (p.text && p.text.length > 0 ? { type: 'text', text: p.text } : null))
        .filter(Boolean);
      if (content.length === 0) {
        content.push({ type: 'text', text: ' ' });
      }
      out.push({ role: m.role, content });
    }
  }
  return { system, messages: out };
}

function toGeminiContents(messages) {
  const contents = [];
  let systemInstruction;
  for (const m of messages) {
    const parts = normalizeContent(m.content);
    if (m.role === 'system') {
      const text = parts.map(p => p.text || '').join('');
      systemInstruction = { parts: [{ text }] };
    } else {
      const geminiParts = parts.map(p => p.type === 'image'
        ? { inline_data: { mime_type: p.mimeType, data: p.data } }
        : { text: p.text || '' });
      contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts: geminiParts });
    }
  }
  return { contents, systemInstruction };
}

function toCohereChat(messages) {
  const textOnly = messages.map(m => ({
    role: m.role,
    content: normalizeContent(m.content).map(p => p.text || '').join('')
  }));
  const last = textOnly[textOnly.length - 1];
  const chatHistory = textOnly.slice(0, -1).filter(m => m.role !== 'system').map(m => ({
    role: m.role === 'assistant' ? 'CHATBOT' : 'USER',
    message: m.content
  }));
  const preamble = textOnly.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined;
  return { message: last?.content || '', chat_history: chatHistory, preamble };
}

function describeFetchError(e) {
  const parts = [];
  const msg = e?.message || String(e);
  parts.push(msg);
  const cause = e?.cause;
  if (cause) {
    if (cause.message && cause.message !== msg) parts.push(cause.message);
    if (cause.code) parts.push(`code=${cause.code}`);
    if (cause.errno) parts.push(`errno=${cause.errno}`);
    if (cause.hostname) parts.push(`host=${cause.hostname}`);
  }
  if (e?.code && !parts.join(' ').includes(e.code)) parts.push(`code=${e.code}`);
  let hint = '';
  const text = parts.join(' ');
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) hint = ' · Проверьте подключение к интернету / DNS';
  else if (/ECONNREFUSED/i.test(text)) hint = ' · Соединение отклонено (прокси/firewall?)';
  else if (/ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(text)) hint = ' · Таймаут соединения (проверьте прокси/VPN)';
  else if (/CERT|TLS|SSL|self.signed|unable to verify/i.test(text)) hint = ' · Проблема с TLS-сертификатом (корпоративный прокси?)';
  else if (/ECONNRESET/i.test(text)) hint = ' · Соединение сброшено сервером';
  else if (/fetch failed/i.test(text) && parts.length === 1) hint = ' · Сетевая ошибка (нет интернета, прокси или блокировка)';
  return text + hint;
}

async function streamChat({ providerId, key, model, messages, extras = {}, stop, webSearch = false, onChunk, onDone, onError, signal }) {
  const provider = PROVIDERS[providerId];
  if (!provider) { onError?.('Unknown provider'); return; }
  const stopArr = Array.isArray(stop) && stop.length ? stop : null;

  // Триммим ключ — пробелы/переводы строк из буфера обмена ломают авторизацию.
  if (typeof key === 'string') key = key.trim();

  try {
    if (provider.type === 'gemini') {
      const url = `${provider.baseURL}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
      const { contents, systemInstruction } = toGeminiContents(messages);
      const body = { contents };
      if (systemInstruction) body.systemInstruction = systemInstruction;
      if (stopArr) body.generationConfig = { stopSequences: stopArr };
      if (webSearch) body.tools = [{ google_search: {} }];
      // OAuth-токенам обычно нужен x-goog-user-project для биллинга.
      // Если пользователь задал extras.userProject — пробрасываем.
      const baseHeaders = { 'Content-Type': 'application/json' };
      if (extras?.userProject) baseHeaders['x-goog-user-project'] = extras.userProject;
      const res = await fetch(url, {
        method: 'POST',
        headers: _geminiAuthHeaders(key, baseHeaders, provider.authMode),
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const msg = _extractErrorMessage(errBody) || errBody.slice(0, 200);
        // Берём ещё и error.status (RESOURCE_EXHAUSTED / INVALID_ARGUMENT и т.п.) —
        // рендерер по нему различает «квота исчерпана» от «временный rate limit».
        let statusCode = '';
        try {
          const obj = JSON.parse(errBody);
          if (obj?.error?.status) statusCode = ` [${obj.error.status}]`;
        } catch (_) {}
        onError?.(`Gemini ${res.status}${statusCode}: ${msg}`);
        return;
      }
      let gotChunk = false;
      let streamErr = null;
      let blockedReason = null;
      const processObj = (obj) => {
        if (obj?.error) {
          streamErr = obj.error.message || JSON.stringify(obj.error);
          return;
        }
        const cand = obj?.candidates?.[0];
        const text = cand?.content?.parts?.map(p => p.text || '').join('') || '';
        if (text) { onChunk?.(text); gotChunk = true; }
        const fin = cand?.finishReason;
        if (fin && fin !== 'STOP' && fin !== 'MAX_TOKENS' && fin !== 'FINISH_REASON_UNSPECIFIED') {
          blockedReason = fin;
        }
      };
      // Гибридный парсер: накапливаем сырое тело и параллельно пробуем SSE-парсинг.
      // Если SSE ничего не выдал — парсим как JSON-массив или NDJSON.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let rawBuf = '';
      let sseBuf = '';
      const processSsePart = (part) => {
        for (const line of part.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data) continue;
          try { processObj(JSON.parse(data)); } catch {}
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        rawBuf += chunk;
        sseBuf += chunk;
        const parts = sseBuf.split(/\r?\n\r?\n/);
        sseBuf = parts.pop() || '';
        for (const part of parts) processSsePart(part);
      }
      // КРИТИЧНО: финальное событие может прийти без завершающих \n\n — обрабатываем хвост.
      if (sseBuf.trim()) processSsePart(sseBuf);
      // Фоллбэк: ответ пришёл не как SSE — пробуем как JSON-массив, потом NDJSON.
      if (!gotChunk && !streamErr && rawBuf.trim()) {
        try {
          const arr = JSON.parse(rawBuf);
          for (const obj of (Array.isArray(arr) ? arr : [arr])) processObj(obj);
        } catch {
          for (const line of rawBuf.split(/\r?\n/)) {
            let s = line.trim();
            if (s.startsWith('data:')) s = s.slice(5).trim();
            s = s.replace(/^,/, '').replace(/,$/, '');
            if (!s || s === '[' || s === ']') continue;
            try { processObj(JSON.parse(s)); } catch {}
          }
        }
      }
      if (streamErr) { onError?.(`Gemini stream error: ${streamErr}`); return; }
      if (!gotChunk) {
        if (blockedReason) {
          onError?.(`Gemini заблокировал ответ (finishReason=${blockedReason}). Попробуй переформулировать запрос или сменить модель.`);
        } else {
          // Дамп Content-Type и начала тела — чтобы было видно, что вообще пришло.
          const ct = res.headers.get('content-type') || 'unknown';
          const preview = rawBuf.slice(0, 200).replace(/\s+/g, ' ').trim() || '(пусто)';
          onError?.(
            `Gemini вернул пустой ответ.\n` +
            `Content-Type: ${ct}\n` +
            `Body: ${preview}\n\n` +
            `Возможные причины: 1) OAuth-токен без scope \`generative-language\`/\`cloud-platform\`; ` +
            `2) нужен заголовок x-goog-user-project с ID GCP-проекта; ` +
            `3) фильтры безопасности модели. Попробуй AI Studio API-ключ (AIza...).`
          );
        }
        return;
      }
      onDone?.();
      return;
    }

    if (provider.type === 'anthropic') {
      const { system, messages: msgs } = toAnthropicMessages(messages);
      const buildAnthBody = (withStop) => {
        const b = { model, messages: msgs, max_tokens: 8192, stream: true };
        if (system) b.system = system;
        if (withStop && stopArr) b.stop_sequences = stopArr;
        if (webSearch) b.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }];
        return JSON.stringify(b);
      };
      let res = await fetch(`${provider.baseURL}/messages`, {
        method: 'POST',
        headers: buildAuthHeaders(provider, key),
        body: buildAnthBody(true),
        signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (stopArr && /stop/i.test(errText) && (res.status === 400 || res.status === 422)) {
          res = await fetch(`${provider.baseURL}/messages`, {
            method: 'POST',
            headers: buildAuthHeaders(provider, key),
            body: buildAnthBody(false),
            signal
          });
          if (!res.ok) { onError?.(`${res.status} ${await res.text().catch(()=>'')}`); return; }
        } else {
          onError?.(`${res.status} ${errText}`);
          return;
        }
      }
      await readSSE(res, (data) => {
        try {
          const obj = JSON.parse(data);
          if (obj.type === 'content_block_delta' && obj.delta?.text) onChunk?.(obj.delta.text);
        } catch {}
      });
      onDone?.();
      return;
    }

    if (provider.type === 'cohere') {
      const { message, chat_history, preamble } = toCohereChat(messages);
      const body = { model, message, chat_history, preamble, stream: true };
      if (stopArr) body.stop_sequences = stopArr;
      const res = await fetch(`${provider.baseURL}/chat`, {
        method: 'POST',
        headers: buildAuthHeaders(provider, key),
        body: JSON.stringify(body),
        signal
      });
      if (!res.ok) { onError?.(`${res.status} ${await res.text().catch(()=>'')}`); return; }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            if (obj.event_type === 'text-generation' && obj.text) onChunk?.(obj.text);
          } catch {}
        }
      }
      onDone?.();
      return;
    }

    if (provider.type === 'hf') {
      const url = `${provider.baseURL}/models/${model}/v1/chat/completions`;
      const buildHfBody = (withStop) => {
        const b = { model, messages: toOpenAIMessages(messages), stream: true };
        if (withStop && stopArr) b.stop = stopArr;
        return JSON.stringify(b);
      };
      let res = await fetch(url, {
        method: 'POST',
        headers: buildAuthHeaders(provider, key),
        body: buildHfBody(true),
        signal
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        if (stopArr && /stop/i.test(errText) && (res.status === 400 || res.status === 422)) {
          res = await fetch(url, {
            method: 'POST',
            headers: buildAuthHeaders(provider, key),
            body: buildHfBody(false),
            signal
          });
          if (!res.ok) { onError?.(`${res.status} ${await res.text().catch(()=>'')}`); return; }
        } else {
          onError?.(`${res.status} ${errText}`);
          return;
        }
      }
      await readSSE(res, (data) => {
        if (data === '[DONE]') return;
        try {
          const obj = JSON.parse(data);
          const delta = obj?.choices?.[0]?.delta?.content || '';
          if (delta) onChunk?.(delta);
        } catch {}
      });
      onDone?.();
      return;
    }

    let url;
    if (provider.type === 'azure') {
      const base = resolveBaseURL(provider, extras);
      const ver = extras.apiVersion || '2024-08-01-preview';
      url = `${base}/openai/deployments/${extras.deployment}/chat/completions?api-version=${ver}`;
    } else {
      url = `${resolveBaseURL(provider, extras)}/chat/completions`;
    }
    // Web search: pick provider-specific way to enable it.
    let effectiveModel = model;
    let extraFields = {};
    if (webSearch) {
      if (providerId === 'openrouter') {
        if (!/:online$/.test(effectiveModel)) effectiveModel = effectiveModel + ':online';
      } else if (providerId === 'openai') {
        extraFields.web_search_options = {};
      } else if (providerId === 'xai') {
        extraFields.search_parameters = { mode: 'on' };
      }
    }
    const buildBody = (withStop) => {
      const b = { model: effectiveModel, messages: toOpenAIMessages(messages), stream: true, ...extraFields };
      if (withStop && stopArr) b.stop = stopArr;
      return JSON.stringify(b);
    };
    let res = await fetch(url, {
      method: 'POST',
      headers: buildAuthHeaders(provider, key, extras),
      body: buildBody(true),
      signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      if (stopArr && /stop\b/i.test(errText) && (res.status === 400 || res.status === 422)) {
        res = await fetch(url, {
          method: 'POST',
          headers: buildAuthHeaders(provider, key, extras),
          body: buildBody(false),
          signal
        });
        if (!res.ok) { onError?.(`${res.status} ${await res.text().catch(()=>'')}`); return; }
      } else {
        onError?.(`${res.status} ${errText}`);
        return;
      }
    }
    await readSSE(res, (data) => {
      if (data === '[DONE]') return;
      try {
        const obj = JSON.parse(data);
        const delta = obj?.choices?.[0]?.delta?.content || '';
        if (delta) onChunk?.(delta);
      } catch {}
    });
    onDone?.();
  } catch (e) {
    if (e?.name === 'AbortError') { onDone?.(); return; }
    onError?.(describeFetchError(e));
  }
}

async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const parts = buf.split('\n\n');
    buf = parts.pop() || '';
    for (const part of parts) {
      const lines = part.split('\n');
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trim();
          if (data) onData(data);
        }
      }
    }
  }
}


module.exports = { checkKey, streamChat };
