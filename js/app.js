/**
 * app.js —— 主业务逻辑（v2 UI 设计系统）
 * 职责：状态管理、UI 渲染（卡片化+动态情绪色）、事件绑定、Prompt 5 维拼接、
 *       流式生成/复制/换一条主链路、历史记录、设置弹窗、主题切换。
 * 依赖：window.CONFIG / window.Store / window.API（按 config→storage→api→app 顺序加载）。
 */
(function () {
  'use strict';

  const CONFIG = window.CONFIG;

  /* ============================================================
   * 一、全局状态
   * ============================================================ */
  const state = {
    reviewType: 'good',
    scenario: 'waimai',
    isCustomScenario: false,
    customScenarioName: '',
    keyword: '',
    wordCount: 'medium',
    platform: 'general',
    generating: false,
    editing: false,
    result: '',
    abortController: null,
    settings: Store.getSettings(),
    theme: Store.getTheme(),
  };

  function initDefaults() {
    const rt = CONFIG.reviewTypes.find((x) => x.default);
    const sc = CONFIG.scenarios.find((x) => x.default);
    const wc = CONFIG.wordCounts.find((x) => x.default);
    if (rt) state.reviewType = rt.id;
    if (sc) state.scenario = sc.id;
    if (wc) state.wordCount = wc.id;
  }

  /* 状态变更统一入口 */
  function setState(patch) {
    Object.assign(state, patch);
    if ('reviewType' in patch || 'scenario' in patch || 'wordCount' in patch) renderTags();
    if ('scenario' in patch || 'reviewType' in patch) {
      state.keyword = '';
      dom['keyword-input'].value = '';
      updatePlaceholder();
      renderQuickKeywords();
    }
    if ('reviewType' in patch) {
      applyMoodColor();
      updateGenBtnText();
    }
    if ('generating' in patch) updateGenBtn();
  }

  /* ============================================================
   * 二、DOM 引用
   * ============================================================ */
  const $ = (id) => document.getElementById(id);
  const dom = {};

  function cacheDom() {
    [
      'review-type-tags', 'scenario-tags', 'word-count-tags',
      'keyword-input', 'quick-keywords',
      'sheet-overlay', 'result-text', 'result-error', 'char-count',
      'meta-scene', 'meta-mood', 'platform-row', 'platform-label',
      'sheet-close', 'sheet-handle-close',
      'btn-edit', 'btn-copy', 'btn-regenerate',
      'btn-generate', 'gen-btn-text',
      'btn-history', 'btn-theme', 'icon-theme',
      'settings-overlay', 'settings-close', 'settings-apikey', 'settings-baseurl',
      'settings-model', 'settings-save',
      'history-overlay', 'history-sidebar', 'history-close', 'btn-clear-history', 'history-list',
      'toast', 'mood-card',
    ].forEach((id) => { dom[id] = $(id); });
  }

  /* ============================================================
   * 三、动态情绪色系统
   * ============================================================ */
  function applyMoodColor() {
    const rt = CONFIG.reviewTypes.find((x) => x.id === state.reviewType);
    if (!rt || !rt.color) return;
    const root = document.documentElement;
    root.style.setProperty('--current-mood', rt.color);
    root.style.setProperty('--current-mood-light', hexToRgba(rt.color, 0.12));
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /* ============================================================
   * 四、工具函数
   * ============================================================ */

  function getCurrentScenario() {
    if (state.isCustomScenario) {
      const base = CONFIG.customScenario;
      return {
        id: 'custom',
        label: state.customScenarioName || '自定义',
        emoji: '✏️',
        placeholder: base.placeholder,
        platforms: base.platforms,
        dimensions: base.dimensions,
        descriptors: base.descriptors,
        flaws: base.flaws,
        quickKeywords: base.quickKeywords,
        negativeQuickKeywords: base.negativeQuickKeywords,
      };
    }
    return CONFIG.scenarios.find((x) => x.id === state.scenario);
  }

  function labelOf(list, id) {
    const item = list.find((x) => x.id === id);
    return item ? item.label : id;
  }

  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.remove('show'), 2000);
  }

  function cleanResult(text) {
    let t = text.trim();
    if (/^["“”'']/.test(t) && /["“”'']$/.test(t)) t = t.slice(1, -1);
    t = t.replace(/^(评价|好评|差评|中肯评价|中肯|评论|满意|不满)\s*[:：]\s*/, '');
    return t.trim();
  }

  function countChars(text) {
    return [...text].length;
  }

  function escapeHTML(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  /* 自定义场景 */
  function onCustomScenarioClick() {
    const name = window.prompt('请输入自定义场景名称，如：美甲、洗车、驾校等', state.customScenarioName || '');
    if (name && name.trim()) {
      state.isCustomScenario = true;
      state.customScenarioName = name.trim();
      state.scenario = 'custom';
      setState({ scenario: 'custom' });
      toast(`已切换到「${name.trim()}」场景`);
    }
  }

  /* ============================================================
   * 五、标签渲染（卡片化）
   * ============================================================ */

  /* 评价类型：mood-opt 卡片 */
  function renderReviewTypeTags() {
    const container = dom['review-type-tags'];
    container.innerHTML = '';
    CONFIG.reviewTypes.forEach((item) => {
      const btn = document.createElement('div');
      btn.className = `mood-opt${item.id === state.reviewType ? ' active' : ''}`;
      btn.innerHTML = `<span class="mood-emoji">${item.emoji}</span><span class="mood-name">${item.label}</span>`;
      btn.addEventListener('click', () => setState({ reviewType: item.id }));
      container.appendChild(btn);
    });
  }

  /* 消费场景：scene-item 卡片 */
  function renderScenarioTags() {
    const container = dom['scenario-tags'];
    container.innerHTML = '';
    CONFIG.scenarios.forEach((item) => {
      const btn = document.createElement('div');
      const isSelected = state.scenario === item.id && !state.isCustomScenario;
      btn.className = `scene-item${isSelected ? ' active' : ''}`;
      btn.innerHTML = `<span class="s-icon">${item.emoji}</span><span class="s-name">${item.label}</span>`;
      btn.addEventListener('click', () => {
        state.isCustomScenario = false;
        state.customScenarioName = '';
        setState({ scenario: item.id });
      });
      container.appendChild(btn);
    });
    // 自定义按钮
    const customBtn = document.createElement('div');
    customBtn.className = `scene-item${state.isCustomScenario ? ' active' : ''}`;
    const customLabel = state.customScenarioName ? state.customScenarioName.slice(0, 4) : '自定义';
    customBtn.innerHTML = `<span class="s-icon">＋</span><span class="s-name">${escapeHTML(customLabel)}</span>`;
    customBtn.addEventListener('click', () => onCustomScenarioClick());
    container.appendChild(customBtn);
  }

  /* 字数：len-opt 卡片 */
  function renderWordCountTags() {
    const container = dom['word-count-tags'];
    container.innerHTML = '';
    CONFIG.wordCounts.forEach((item) => {
      const btn = document.createElement('div');
      btn.className = `len-opt${item.id === state.wordCount ? ' active' : ''}`;
      btn.innerHTML = `<span class="len-name">${item.label}</span>`;
      btn.addEventListener('click', () => setState({ wordCount: item.id }));
      container.appendChild(btn);
    });
  }

  function renderTags() {
    renderReviewTypeTags();
    renderScenarioTags();
    renderWordCountTags();
  }

  function updatePlaceholder() {
    const sc = getCurrentScenario();
    if (sc) dom['keyword-input'].placeholder = sc.placeholder;
  }

  /* 关键词：kw-chip（支持选中/取消切换） */
  function renderQuickKeywords() {
    const sc = getCurrentScenario();
    const container = dom['quick-keywords'];
    container.innerHTML = '';
    if (!sc) return;
    const isNegative = state.reviewType === 'bad' || state.reviewType === 'severe-bad';
    const words = isNegative ? sc.negativeQuickKeywords : sc.quickKeywords;
    if (!words || words.length === 0) return;
    const selected = getSelectedKeywords();
    words.forEach((word) => {
      const chip = document.createElement('button');
      chip.type = 'button';
      const isAdded = selected.includes(word);
      chip.className = `kw-chip${isAdded ? ' added' : ''}`;
      chip.innerHTML = `<span class="kw-plus">${isAdded ? '✓' : '+'}</span> ${escapeHTML(word)}`;
      chip.addEventListener('click', () => toggleKeyword(word));
      container.appendChild(chip);
    });
  }

  function getSelectedKeywords() {
    return dom['keyword-input'].value
      .split(/[，,]/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  function toggleKeyword(word) {
    const words = getSelectedKeywords();
    if (words.includes(word)) {
      // 取消选中
      const newList = words.filter((w) => w !== word);
      dom['keyword-input'].value = newList.join('，');
    } else {
      // 添加
      const newList = [...words, word];
      dom['keyword-input'].value = newList.join('，');
    }
    state.keyword = dom['keyword-input'].value;
    renderQuickKeywords();
  }

  /* ============================================================
   * 六、生成按钮
   * ============================================================ */
  const genBtnTexts = {
    'super-good': '帮我写一条超赞好评 ✨',
    'good': '帮我写一条满意好评',
    'fair': '帮我写一条中肯评价',
    'bad': '帮我写一条不满反馈',
    'severe-bad': '帮我写一条避雷评价 ⚠️',
  };

  function updateGenBtnText() {
    dom['gen-btn-text'].textContent = genBtnTexts[state.reviewType] || '帮我写一条评价';
  }

  function updateGenBtn() {
    if (state.generating) {
      dom['btn-generate'].disabled = true;
      dom['gen-btn-text'].textContent = '生成中...';
    } else {
      dom['btn-generate'].disabled = false;
      updateGenBtnText();
    }
  }

  /* ============================================================
   * 七、结果 Sheet
   * ============================================================ */
  function showResultSheet() {
    dom['sheet-overlay'].classList.add('show');
    const sc = getCurrentScenario();
    const rt = CONFIG.reviewTypes.find((x) => x.id === state.reviewType);
    dom['meta-scene'].textContent = sc ? sc.label : '场景';
    dom['meta-mood'].textContent = rt ? rt.label : '评价';
  }

  function closeResultSheet() {
    dom['sheet-overlay'].classList.remove('show');
  }

  function resetResultUI() {
    dom['result-text'].textContent = '';
    dom['result-text'].setAttribute('contenteditable', 'false');
    dom['result-text'].classList.remove('editing');
    dom['result-error'].classList.add('hidden');
    dom['result-error'].textContent = '';
    dom['char-count'].textContent = '';
    dom['platform-label'].style.display = 'none';
    // 清除旧的平台标签
    dom['platform-row'].querySelectorAll('.platform-hint').forEach((el) => el.remove());
    dom['btn-edit'].textContent = '编辑';
    state.editing = false;
  }

  function showError(msg) {
    dom['result-error'].textContent = msg;
    dom['result-error'].classList.remove('hidden');
    dom['result-text'].innerHTML = '';
  }

  function updateCharCount(text) {
    dom['char-count'].textContent = `${countChars(text)} 字`;
  }

  function showPlatforms() {
    const sc = getCurrentScenario();
    if (!sc || !sc.platforms) return;
    dom['platform-label'].style.display = 'inline';
    dom['platform-row'].querySelectorAll('.platform-hint').forEach((el) => el.remove());
    sc.platforms.forEach((pf) => {
      const span = document.createElement('span');
      span.className = 'platform-hint';
      span.textContent = pf;
      dom['platform-row'].appendChild(span);
    });
  }

  /* 编辑切换 */
  function onEdit() {
    if (state.generating) return;
    state.editing = !state.editing;
    if (state.editing) {
      dom['result-text'].setAttribute('contenteditable', 'true');
      dom['result-text'].classList.add('editing');
      dom['btn-edit'].textContent = '完成';
      // 延迟 focus，确保 contenteditable 已生效
      setTimeout(() => {
        dom['result-text'].focus();
        const range = document.createRange();
        range.selectNodeContents(dom['result-text']);
        range.collapse(false);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }, 50);
    } else {
      dom['result-text'].setAttribute('contenteditable', 'false');
      dom['result-text'].classList.remove('editing');
      dom['btn-edit'].textContent = '编辑';
      state.result = dom['result-text'].textContent;
      updateCharCount(state.result);
    }
  }

  /* ============================================================
   * 八、Prompt 拼接（保持不变）
   * ============================================================ */
  function buildScenarioPrompt() {
    const s = getCurrentScenario();
    if (!s) return '';
    return `当前场景：${s.label}。
可参考的体验维度（不必全提，挑 1-3 个自然融入）：${s.dimensions.join('、')}。
可用到的真实描述词（参考语气，可改写不要照搬）：${s.descriptors.join('、')}。
可选的微缺点（>80 字时优先从这里挑 1 个融入）：${s.flaws.join('、')}。`;
  }

  function buildMessages() {
    const systemPrompt = [
      CONFIG.prompt.base,
      CONFIG.prompt.reviewType[state.reviewType],
      buildScenarioPrompt(),
      CONFIG.prompt.platform[state.platform],
      CONFIG.prompt.wordCount[state.wordCount],
    ].join('\n\n');

    const kw = state.keyword.trim();
    const userPrompt = kw
      ? `请围绕「${kw}」来写，结合上面的场景和风格要求。`
      : `请结合上面的场景和风格要求写一条评价，主题自定但要真实合理。`;

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];
  }

  /* ============================================================
   * 九、核心流程：生成 / 换一条
   * ============================================================ */
  async function onGenerate() {
    if (state.generating) return;
    if (state.editing) onEdit();

    if (!state.settings.baseUrl && !state.settings.apiKey) {
      openSettings();
      toast('请先配置 API Key 或接口地址');
      return;
    }

    if (state.abortController) state.abortController.abort();
    const ac = new AbortController();
    state.abortController = ac;

    setState({ generating: true, result: '' });
    showResultSheet();
    resetResultUI();
    dom['result-text'].innerHTML = `<div class="loading-wrap"><div class="dots"><span></span><span></span><span></span></div>正在为你生成...</div>`;

    const messages = buildMessages();
    let acc = '';

    try {
      await API.generateWithFallback(
        { ...state.settings, messages },
        { signal: ac.signal },
        (delta) => {
          if (ac !== state.abortController) return;
          acc += delta;
          state.result = acc;
          dom['result-text'].textContent = acc;
          updateCharCount(acc);
        }
      );

      if (ac !== state.abortController) return;

      const cleaned = cleanResult(acc);
      if (cleaned !== acc) {
        acc = cleaned;
        state.result = acc;
        dom['result-text'].textContent = acc;
        updateCharCount(acc);
      }

      showPlatforms();

      Store.addHistory({
        content: acc,
        scenario: state.scenario,
        reviewType: state.reviewType,
        wordCount: state.wordCount,
        platform: state.platform,
        keyword: state.keyword,
      });
    } catch (err) {
      if (ac !== state.abortController) return;
      const isAbort = err && (err.type === 'aborted' || err.name === 'AbortError');
      if (!isAbort) {
        showError((err && err.message) || '生成失败，请重试');
      }
    } finally {
      if (ac === state.abortController) {
        setState({ generating: false, abortController: null });
      }
    }
  }

  function onRegenerate() {
    if (state.editing) onEdit();
    if (state.abortController) state.abortController.abort();
    state.generating = false;
    onGenerate();
  }

  /* ============================================================
   * 十、复制
   * ============================================================ */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }

  async function onCopy() {
    // 如果正在生成中，不允许复制
    if (state.generating) { toast('正在生成中，请稍候'); return; }
    const text = dom['result-text'].textContent.trim();
    if (!text) { toast('还没有内容可复制'); return; }
    const ok = await copyText(text);
    if (ok) {
      dom['btn-copy'].innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>已复制`;
      toast('已复制，去发布吧');
      setTimeout(() => {
        dom['btn-copy'].innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>复制去发布`;
      }, 2000);
    } else {
      toast('可以手动选择复制');
    }
  }

  /* ============================================================
   * 十一、设置弹窗
   * ============================================================ */
  function openSettings() {
    dom['settings-apikey'].value = state.settings.apiKey || '';
    dom['settings-baseurl'].value = state.settings.baseUrl || '';
    dom['settings-model'].value = state.settings.model || CONFIG.api.defaultModel;
    dom['settings-overlay'].classList.add('show');
  }

  function closeSettings() {
    dom['settings-overlay'].classList.remove('show');
  }

  function saveSettings() {
    const apiKey = dom['settings-apikey'].value.trim();
    const baseUrl = dom['settings-baseurl'].value.trim();
    const model = dom['settings-model'].value.trim() || CONFIG.api.defaultModel;
    Store.setSettings({ apiKey, baseUrl, model });
    setState({ settings: Store.getSettings() });
    closeSettings();
    toast('设置已保存');
  }

  /* ============================================================
   * 十二、历史记录
   * ============================================================ */
  function openHistory() {
    renderHistory();
    dom['history-overlay'].classList.add('show');
    dom['history-sidebar'].classList.add('show');
  }

  function closeHistory() {
    dom['history-overlay'].classList.remove('show');
    dom['history-sidebar'].classList.remove('show');
  }

  function renderHistory() {
    const list = Store.getHistory();
    dom['history-list'].innerHTML = '';
    if (list.length === 0) {
      dom['history-list'].innerHTML = '<div class="history-empty">暂无历史记录</div>';
      return;
    }
    list.forEach((item) => {
      const card = document.createElement('article');
      card.className = 'history-item';
      const sceneLabel = item.scenario === 'custom'
        ? '自定义'
        : labelOf(CONFIG.scenarios, item.scenario);
      const moodLabel = labelOf(CONFIG.reviewTypes, item.reviewType);
      card.innerHTML = `
        <div class="history-meta">
          <span>${escapeHTML(sceneLabel)} · ${escapeHTML(moodLabel)}</span>
          <span>${formatTime(item.time)}</span>
        </div>
        <p class="history-content">${escapeHTML(item.content)}</p>
        <div class="history-actions">
          <button data-action="reuse">复用</button>
          <button data-action="copy">复制</button>
          <button data-action="delete">删除</button>
        </div>`;
      card.querySelector('[data-action="reuse"]').addEventListener('click', () => {
        setState({
          scenario: item.scenario,
          reviewType: item.reviewType,
          wordCount: item.wordCount,
          keyword: item.keyword || '',
        });
        dom['keyword-input'].value = item.keyword || '';
        closeHistory();
        setTimeout(() => onGenerate(), 300);
      });
      card.querySelector('[data-action="copy"]').addEventListener('click', async () => {
        const ok = await copyText(item.content);
        toast(ok ? '已复制' : '复制失败');
      });
      card.querySelector('[data-action="delete"]').addEventListener('click', () => {
        Store.deleteHistory(item.id);
        renderHistory();
        toast('已删除');
      });
      dom['history-list'].appendChild(card);
    });
  }

  function onClearHistory() {
    if (Store.getHistory().length === 0) { toast('暂无历史记录'); return; }
    if (!confirm('确定清空全部历史记录？')) return;
    Store.clearHistory();
    renderHistory();
    toast('已清空历史');
  }

  /* ============================================================
   * 十三、主题切换（三档循环）
   * ============================================================ */
  const themeIcons = {
    light: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
    dark: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
    system: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/>',
  };

  function applyTheme() {
    const t = state.theme;
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = t === 'dark' || (t === 'system' && sysDark);
    document.documentElement.classList.toggle('dark', dark);
    dom['icon-theme'].innerHTML = themeIcons[t] || themeIcons.system;
    dom['btn-theme'].title = t === 'system' ? '跟随系统' : t === 'light' ? '浅色模式' : '深色模式';
  }

  function cycleTheme() {
    const order = ['system', 'light', 'dark'];
    state.theme = order[(order.indexOf(state.theme) + 1) % order.length];
    Store.setTheme(state.theme);
    applyTheme();
    toast(state.theme === 'system' ? '跟随系统' : state.theme === 'light' ? '浅色模式' : '深色模式');
  }

  /* ============================================================
   * 十四、事件绑定
   * ============================================================ */
  function bindEvents() {
    // 关键词输入
    dom['keyword-input'].addEventListener('input', () => {
      state.keyword = dom['keyword-input'].value.replace(/[\r\n]+/g, ' ').trim();
      renderQuickKeywords();
    });

    // 生成 / 换一条 / 复制 / 编辑
    dom['btn-generate'].addEventListener('click', onGenerate);
    dom['btn-regenerate'].addEventListener('click', onRegenerate);
    dom['btn-copy'].addEventListener('click', onCopy);
    dom['btn-edit'].addEventListener('click', onEdit);

    // 结果区直接点击即可编辑
    dom['result-text'].addEventListener('click', () => {
      if (!state.editing && !state.generating) {
        onEdit();
      }
    });

    // 结果区编辑时实时更新字数
    dom['result-text'].addEventListener('input', () => {
      if (state.editing) updateCharCount(dom['result-text'].textContent);
    });

    // 点击 sheet 遮罩关闭
    dom['sheet-overlay'].addEventListener('click', (e) => {
      if (e.target === dom['sheet-overlay']) {
        if (state.generating) return;
        if (state.editing) onEdit();
        closeResultSheet();
      }
    });

    // 关闭按钮和拖拽条
    dom['sheet-close'].addEventListener('click', () => {
      if (state.generating) return;
      if (state.editing) onEdit();
      closeResultSheet();
    });
    dom['sheet-handle-close'].addEventListener('click', () => {
      if (state.generating) return;
      if (state.editing) onEdit();
      closeResultSheet();
    });

    // 设置弹窗（保留功能，但按钮已从UI移除）
    dom['settings-close'].addEventListener('click', closeSettings);
    dom['settings-save'].addEventListener('click', saveSettings);
    dom['settings-overlay'].addEventListener('click', (e) => {
      if (e.target === dom['settings-overlay']) closeSettings();
    });

    // 历史侧边栏
    dom['btn-history'].addEventListener('click', openHistory);
    dom['history-close'].addEventListener('click', closeHistory);
    dom['history-overlay'].addEventListener('click', closeHistory);
    dom['btn-clear-history'].addEventListener('click', onClearHistory);

    // 主题切换
    dom['btn-theme'].addEventListener('click', cycleTheme);
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme();
    });

    // 移动端键盘弹出时滚动到可视区
    dom['keyword-input'].addEventListener('focus', () => {
      setTimeout(() => dom['keyword-input'].scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    });

    // ESC 关闭弹窗
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (dom['sheet-overlay'].classList.contains('show')) closeResultSheet();
      if (dom['settings-overlay'].classList.contains('show')) closeSettings();
      if (dom['history-overlay'].classList.contains('show')) closeHistory();
    });
  }

  /* ============================================================
   * 十五、初始化
   * ============================================================ */
  function init() {
    cacheDom();
    initDefaults();
    renderTags();
    updatePlaceholder();
    renderQuickKeywords();
    applyMoodColor();
    updateGenBtnText();
    updateGenBtn();
    applyTheme();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
