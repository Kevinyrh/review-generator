/**
 * api.js —— 大模型 API 调用封装
 * 职责：OpenAI 兼容接口的流式调用（SSE）、错误分类、降级方案。
 * 不依赖业务状态，仅接收 opts + signal + onDelta 回调。
 */
(function () {
  'use strict';

  const A = window.CONFIG.api;

  /* ---------- URL 拼接（容错：去末尾斜杠 + 去误填的 /chat/completions） ---------- */
  function resolveUrl(baseUrl) {
    const root = (baseUrl && baseUrl.trim()) || A.officialBaseUrl;
    const clean = root.replace(/\/+$/, '');                       // 去末尾斜杠
    const base = clean.replace(/\/chat\/completions$/i, '');      // 容错：用户误填完整路径
    return base + A.chatCompletionsPath;
  }

  /* ---------- 错误分类（返回友好中文提示，不暴露技术报错） ---------- */
  function classifyError(status) {
    const map = {
      401: { type: 'auth', message: 'API Key 无效或已过期，请检查设置。' },
      403: { type: 'forbidden', message: '密钥无权限或地区受限，请确认接口地址与密钥。' },
      404: { type: 'url', message: '接口地址错误（404），请检查 base_url。' },
      400: { type: 'param', message: '请求参数错误，可能是模型名称不对。' },
      429: { type: 'rate', message: '请求过于频繁或额度不足，请稍后再试。' },
    };
    if (map[status]) return { ...map[status], status };
    if (status >= 500) return { type: 'server', message: '服务端暂时不可用，请稍后重试。', status };
    return { type: 'http', message: `请求失败（${status}）。`, status };
  }

  function networkError() {
    return { type: 'network', message: '网络连接失败，请检查网络或接口地址。' };
  }

  function abortedError() {
    return { type: 'aborted', message: '已取消。' };
  }

  /* ---------- 安全读取响应文本 ---------- */
  async function safeText(resp) {
    try { return await resp.text(); } catch { return ''; }
  }

  /* ---------- 构建请求体 ---------- */
  function buildBody(opts, stream) {
    return JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: A.temperature,
      max_tokens: A.maxTokens,
      stream: stream,
    });
  }

  function buildHeaders(opts) {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${opts.apiKey}`,
    };
  }

  /* ---------- 流式：async generator，逐字 yield delta ---------- */
  async function* streamChat(opts, { signal } = {}) {
    const url = resolveUrl(opts.baseUrl);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(opts),
        body: buildBody(opts, true),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw abortedError();
      throw networkError();
    }

    if (!resp.ok) throw classifyError(resp.status);
    if (!resp.body) throw { type: 'no-stream', message: '当前环境不支持流式响应。' };

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        if (e.name === 'AbortError') throw abortedError();
        throw networkError();
      }
      const { done, value } = chunk;
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // 按行切分，最后一行可能不完整，留到下次拼接
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t || !t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          const json = JSON.parse(data);
          const delta = json.choices && json.choices[0] && json.choices[0].delta && json.choices[0].delta.content;
          if (delta) yield delta;
        } catch (_) { /* 跳过无法解析的行 */ }
      }
    }
  }

  /* ---------- 非流式：返回完整文本 ---------- */
  async function chat(opts, { signal } = {}) {
    const url = resolveUrl(opts.baseUrl);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: buildHeaders(opts),
        body: buildBody(opts, false),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw abortedError();
      throw networkError();
    }
    if (!resp.ok) throw classifyError(resp.status);
    try {
      const json = await resp.json();
      const content = json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
      return content || '';
    } catch (e) {
      if (e.name === 'AbortError') throw abortedError();
      throw { type: 'parse', message: '响应解析失败，请重试。' };
    }
  }

  /* ---------- 模拟打字机（降级用，逐字输出） ---------- */
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  async function typewriter(text, onDelta, signal) {
    for (const ch of text) {
      if (signal && signal.aborted) throw abortedError();
      onDelta(ch);
      await sleep(window.CONFIG.ui.typewriterIntervalMs);
    }
  }

  /* ---------- 统一入口：流式 + 首 token 超时降级 ---------- */
  /**
   * @param {object} opts - { apiKey, baseUrl, model, messages }
   * @param {object} ctrl - { signal } AbortSignal
   * @param {function} onDelta - 每个 delta 的回调
   */
  async function generateWithFallback(opts, ctrl, onDelta) {
    const signal = ctrl && ctrl.signal;
    // 首 token 超时计时器：超时则 abort 流式，触发降级
    let firstToken = false;
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => {
      if (!firstToken) timeoutCtrl.abort();
    }, A.streamFirstTokenTimeoutMs);

    // 合并用户 signal 与超时 signal：任一触发都中止流式
    const combined = new AbortController();
    const onUserAbort = () => combined.abort();
    const onTimeoutAbort = () => {
      if (!firstToken) combined.abort({ type: 'stream-timeout' });
    };
    if (signal) signal.addEventListener('abort', onUserAbort);
    timeoutCtrl.signal.addEventListener('abort', onTimeoutAbort);

    try {
      const gen = streamChat(opts, { signal: combined.signal });
      for await (const d of gen) {
        if (!firstToken) { firstToken = true; clearTimeout(timer); }
        onDelta(d);
      }
      clearTimeout(timer);
      return; // 成功完成
    } catch (err) {
      clearTimeout(timer);
      // 用户主动取消：不降级，向上抛
      const isUserAbort = signal && signal.aborted;
      const isAbort = err.type === 'aborted' || err.name === 'AbortError';
      if (isUserAbort || (isAbort && !(timeoutCtrl.signal.aborted && !firstToken))) {
        throw abortedError();
      }
      // 首 token 超时 或 不支持流式 或 网络错误 → 降级非流式 + 打字机
      // 但若已是 HTTP 错误（401/429 等），直接抛出，不降级
      if (err.status) throw err;
      // 降级路径
      const full = await chat(opts, { signal });
      await typewriter(full, onDelta, signal);
    } finally {
      if (signal) signal.removeEventListener('abort', onUserAbort);
      timeoutCtrl.signal.removeEventListener('abort', onTimeoutAbort);
    }
  }

  /* ---------- 暴露接口 ---------- */
  window.API = {
    streamChat,
    chat,
    generateWithFallback,
    classifyError,
  };
})();
