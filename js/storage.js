/**
 * storage.js —— 本地存储封装
 * 职责：历史记录、用户配置、主题偏好的读写，含容量控制与容错。
 * 与业务逻辑、API 调用完全解耦。
 */
(function () {
  'use strict';

  const KEYS = window.CONFIG.storage.keys;
  const HISTORY_MAX = window.CONFIG.storage.historyMax;

  /* ---------- 安全读写（容错 JSON 解析失败 / QuotaExceededError） ---------- */

  function safeGet(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function safeSet(key, val) {
    try {
      localStorage.setItem(key, val);
      return true;
    } catch (e) {
      // 配额超限：若是历史记录，砍半后重试一次
      if (e.name === 'QuotaExceededError' && key === KEYS.history) {
        try {
          const list = getHistory();
          list.length = Math.floor(list.length / 2);
          localStorage.setItem(key, JSON.stringify(list));
          return true;
        } catch (_) {
          return false;
        }
      }
      return false;
    }
  }

  /* ---------- 唯一 id 生成 ---------- */
  function genId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /* ---------- 历史记录 ---------- */

  function getHistory() {
    const list = safeGet(KEYS.history, []);
    return Array.isArray(list) ? list : [];
  }

  /**
   * 新增一条历史记录（插到最前），超出上限自动截断最早的。
   * @param {{content:string,scenario:string,reviewType:string,wordCount:string,platform:string,keyword:string}} item
   */
  function addHistory(item) {
    const list = getHistory();
    list.unshift({
      id: genId(),
      content: item.content,
      scenario: item.scenario,
      reviewType: item.reviewType,
      wordCount: item.wordCount,
      platform: item.platform,
      keyword: item.keyword,
      time: Date.now(),
    });
    // 超出上限截断（最早的在尾部）
    if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
    safeSet(KEYS.history, JSON.stringify(list));
  }

  function deleteHistory(id) {
    const list = getHistory().filter((x) => x.id !== id);
    safeSet(KEYS.history, JSON.stringify(list));
  }

  function clearHistory() {
    safeSet(KEYS.history, JSON.stringify([]));
  }

  /* ---------- 用户设置（API Key / 接口地址 / 模型） ---------- */

  function getSettings() {
    const s = safeGet(KEYS.settings, null);
    return {
      apiKey: (s && s.apiKey) || '',
      baseUrl: (s && s.baseUrl !== undefined) ? s.baseUrl : window.CONFIG.api.defaultBaseUrl,
      model: (s && s.model) || window.CONFIG.api.defaultModel,
    };
  }

  function setSettings(s) {
    safeSet(KEYS.settings, JSON.stringify({
      apiKey: s.apiKey || '',
      baseUrl: s.baseUrl || '',
      model: s.model || window.CONFIG.api.defaultModel,
    }));
  }

  /* ---------- 主题偏好（light / dark / system） ---------- */

  function getTheme() {
    return safeGet(KEYS.theme, 'system');
  }

  function setTheme(t) {
    safeSet(KEYS.theme, JSON.stringify(t));
  }

  /* ---------- 暴露接口 ---------- */
  window.Store = {
    getHistory,
    addHistory,
    deleteHistory,
    clearHistory,
    getSettings,
    setSettings,
    getTheme,
    setTheme,
  };
})();
