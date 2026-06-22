/**
 * app.js —— 主业务逻辑
 * 职责：状态管理、UI 渲染、事件绑定、Prompt 5 维拼接、生成/复制/换一条主链路、
 *       历史记录、设置弹窗、暗黑模式。
 * 依赖：window.CONFIG / window.Store / window.API（按 config→storage→api→app 顺序加载）。
 */
(function () {
  'use strict';

  const CONFIG = window.CONFIG;

  /* ============================================================
   * 一、全局状态
   * ============================================================ */
  const state = {
    reviewType: 'good',       // 当前评价类型 id
    scenario: 'waimai',       // 当前场景 id
    keyword: '',              // 关键词
    wordCount: 'medium',      // 字数档位 id
    platform: 'general',      // 平台风格 id
    generating: false,        // 是否正在流式生成
    editing: false,           // 是否正在编辑结果
    result: '',               // 当前结果文本
    abortController: null,    // 取消当前流的控制器
    settings: Store.getSettings(),
    theme: Store.getTheme(),
  };

  // 从 CONFIG 读取默认选中项，初始化 state
  function initDefaults() {
    const rt = CONFIG.reviewTypes.find((x) => x.default);
    const sc = CONFIG.scenarios.find((x) => x.default);
    const wc = CONFIG.wordCounts.find((x) => x.default);
    const pf = CONFIG.platforms.find((x) => x.default);
    if (rt) state.reviewType = rt.id;
    if (sc) state.scenario = sc.id;
    if (wc) state.wordCount = wc.id;
    if (pf) state.platform = pf.id;
  }

  /* 状态变更统一入口：浅合并 + 触发相关 render */
  function setState(patch) {
    Object.assign(state, patch);
    if ('reviewType' in patch || 'scenario' in patch || 'wordCount' in patch || 'platform' in patch) renderTags();
    if ('scenario' in patch || 'reviewType' in patch) {
      // 切换场景或评价类型时清空关键词（不同场景/类型的词不通用）
      state.keyword = '';
      dom['keyword-input'].value = '';
      updatePlaceholder();
      renderQuickKeywords();
    }
    if ('generating' in patch || 'settings' in patch) updateGenerateBtn();
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
      'result-card', 'result-text', 'result-error', 'char-count',
      'result-actions', 'btn-edit', 'btn-copy', 'btn-regenerate',
      'btn-generate', 'gen-spinner', 'gen-btn-text',
      'btn-settings', 'btn-history', 'btn-theme', 'icon-sun', 'icon-moon',
      'settings-overlay', 'settings-close', 'settings-apikey', 'settings-baseurl',
      'settings-model', 'settings-save',
      'history-overlay', 'history-sidebar', 'history-close', 'btn-clear-history', 'history-list',
      'toast',
    ].forEach((id) => { dom[id] = $(id); });
  }

  /* ============================================================
   * 三、工具函数
   * ============================================================ */

  // 按 id 查 label
  function labelOf(list, id) {
    const item = list.find((x) => x.id === id);
    return item ? item.label : id;
  }

  // 格式化时间 MM-DD HH:mm
  function formatTime(ts) {
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // Toast 轻提示
  let toastTimer = null;
  function toast(msg) {
    dom.toast.textContent = msg;
    dom.toast.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => dom.toast.classList.add('hidden'), CONFIG.ui.copyToastMs);
  }

  // 结果清洗：去首尾成对引号、去常见前缀（模型偶尔不听话的兜底）
  function cleanResult(text) {
    let t = text.trim();
    if (/^["“”'']/.test(t) && /["“”'']$/.test(t)) t = t.slice(1, -1);
    t = t.replace(/^(评价|好评|差评|中肯评价|中肯|评论)\s*[:：]\s*/, '');
    return t.trim();
  }

  // 计算中文字数（按字符计，与平台字数统计习惯一致）
  function countChars(text) {
    return [...text].length;
  }

  /* ============================================================
   * 四、Tag 渲染（CONFIG 驱动，避免硬编码）
   * ============================================================ */

  function tagClass(selected) {
    const base = 'min-tap rounded-full px-4 text-sm font-medium active:scale-95 transition whitespace-nowrap flex items-center';
    return selected
      ? `${base} bg-brand text-white`
      : `${base} bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-[#2a2a2a] dark:text-gray-300 dark:hover:bg-[#333]`;
  }

  function renderTagGroup(container, list, currentId, onSelect) {
    container.innerHTML = '';
    list.forEach((item) => {
      const btn = document.createElement('button');
      btn.className = tagClass(item.id === currentId);
      btn.style.height = '36px';
      btn.textContent = item.label;
      btn.addEventListener('click', () => onSelect(item.id));
      container.appendChild(btn);
    });
  }

  function renderTags() {
    renderTagGroup(dom['review-type-tags'], CONFIG.reviewTypes, state.reviewType, (id) => setState({ reviewType: id }));
    renderTagGroup(dom['scenario-tags'], CONFIG.scenarios, state.scenario, (id) => setState({ scenario: id }));
    renderTagGroup(dom['word-count-tags'], CONFIG.wordCounts, state.wordCount, (id) => setState({ wordCount: id }));
  }

  function updatePlaceholder() {
    const sc = CONFIG.scenarios.find((x) => x.id === state.scenario);
    if (sc) dom['keyword-input'].placeholder = sc.placeholder;
  }

  /* 渲染当前场景的关键词快选标签（差评/严重避雷显示负面词，其余显示正面词） */
  function renderQuickKeywords() {
    const sc = CONFIG.scenarios.find((x) => x.id === state.scenario);
    const container = dom['quick-keywords'];
    container.innerHTML = '';
    if (!sc) return;
    // 差评和严重避雷显示负面快选词，其余显示正面
    const isNegative = state.reviewType === 'bad' || state.reviewType === 'severe-bad';
    const words = isNegative ? sc.negativeQuickKeywords : sc.quickKeywords;
    if (!words || words.length === 0) return;
    words.forEach((word) => {
      const btn = document.createElement('button');
      const colorClass = isNegative
        ? 'hover:border-red-400 hover:text-red-500 dark:hover:border-red-500 dark:hover:text-red-400'
        : 'hover:border-brand hover:text-brand dark:hover:border-brand dark:hover:text-brand';
      btn.className = `h-7 px-3 rounded-full text-xs bg-gray-50 text-gray-500 border border-gray-200 ${colorClass} dark:bg-[#2a2a2a] dark:text-gray-400 dark:border-gray-700 active:scale-95 transition`;
      btn.textContent = '+ ' + word;
      btn.addEventListener('click', () => onQuickKeyword(word));
      container.appendChild(btn);
    });
  }

  /* 点击快选关键词：追加到输入框（已有则不重复） */
  function onQuickKeyword(word) {
    const input = dom['keyword-input'];
    const current = input.value.trim();
    if (current && current.includes(word)) {
      toast('已添加过该关键词');
      return;
    }
    input.value = current ? `${current}，${word}` : word;
    state.keyword = input.value;
    input.focus();
  }

  /* ============================================================
   * 五、生成按钮状态
   * ============================================================ */
  function updateGenerateBtn() {
    if (state.generating) {
      dom['btn-generate'].disabled = true;
      dom['gen-btn-text'].textContent = '生成中...';
      dom['gen-spinner'].classList.remove('hidden');
    } else {
      dom['btn-generate'].disabled = false;
      dom['gen-btn-text'].textContent = '生成评价';
      dom['gen-spinner'].classList.add('hidden');
    }
  }

  /* ============================================================
   * 六、结果卡片显隐
   * ============================================================ */
  function showResultCard() {
    dom['result-card'].classList.remove('hidden');
    dom['result-card'].classList.add('fade-in');
    dom['result-actions'].classList.remove('hidden');
    dom['result-actions'].classList.add('flex');
  }

  function resetResultUI() {
    dom['result-text'].textContent = '';
    dom['result-text'].classList.remove('done');
    dom['result-text'].setAttribute('contenteditable', 'false');
    dom['result-error'].classList.add('hidden');
    dom['result-error'].textContent = '';
    dom['char-count'].textContent = '共 0 字';
    // 重置编辑按钮文案
    dom['btn-edit'].textContent = '编辑';
    state.editing = false;
  }

  function showError(msg) {
    dom['result-error'].textContent = msg;
    dom['result-error'].classList.remove('hidden');
    dom['result-text'].classList.add('done');
    dom['result-text'].classList.remove('cursor-blink');
  }

  function updateCharCount(text) {
    dom['char-count'].textContent = `共 ${countChars(text)} 字`;
  }

  /* 切换结果编辑态 */
  function onEdit() {
    // 生成中不允许编辑
    if (state.generating) return;
    state.editing = !state.editing;
    if (state.editing) {
      dom['result-text'].setAttribute('contenteditable', 'true');
      dom['result-text'].classList.remove('done');
      dom['btn-edit'].textContent = '完成';
      dom['result-text'].focus();
      // 光标移到末尾
      const range = document.createRange();
      range.selectNodeContents(dom['result-text']);
      range.collapse(false);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } else {
      dom['result-text'].setAttribute('contenteditable', 'false');
      dom['result-text'].classList.add('done');
      dom['btn-edit'].textContent = '编辑';
      // 从 DOM 读回最新文本，同步 state
      state.result = dom['result-text'].textContent;
      updateCharCount(state.result);
    }
  }

  /* ============================================================
   * 七、Prompt 5 维拼接
   * ============================================================ */

  // 维度 3：场景专属细节库（从 scenarios 数据动态生成）
  function buildScenarioPrompt(scenarioId) {
    const s = CONFIG.scenarios.find((x) => x.id === scenarioId);
    if (!s) return '';
    return `当前场景：${s.label}。
可参考的体验维度（不必全提，挑 1-3 个自然融入）：${s.dimensions.join('、')}。
可用到的真实描述词（参考语气，可改写不要照搬）：${s.descriptors.join('、')}。
可选的微缺点（>80 字时优先从这里挑 1 个融入）：${s.flaws.join('、')}。`;
  }

  // 组装 messages：system = 5 维拼接，user = 关键词
  function buildMessages() {
    const systemPrompt = [
      CONFIG.prompt.base,
      CONFIG.prompt.reviewType[state.reviewType],
      buildScenarioPrompt(state.scenario),
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
   * 八、核心流程：生成 / 换一条
   * ============================================================ */
  async function onGenerate() {
    // 防重入
    if (state.generating) return;
    // 若正在编辑，先退出编辑态
    if (state.editing) onEdit();

    // 未配置 API Key → 引导设置
    if (!state.settings.apiKey) {
      openSettings();
      toast('请先配置 API Key');
      return;
    }

    // 取消任何残留流
    if (state.abortController) state.abortController.abort();
    const ac = new AbortController();
    state.abortController = ac;

    setState({ generating: true, result: '' });
    showResultCard();
    resetResultUI();
    dom['result-text'].classList.add('cursor-blink');
    dom['result-text'].classList.remove('done');

    const messages = buildMessages();
    let acc = '';

    try {
      await API.generateWithFallback(
        { ...state.settings, messages },
        { signal: ac.signal },
        (delta) => {
          // 校验：丢弃过时流的 delta（换一条后旧流残留）
          if (ac !== state.abortController) return;
          acc += delta;
          state.result = acc;
          dom['result-text'].textContent = acc;
          updateCharCount(acc);
        }
      );

      // 流式完成后校验当前流仍有效
      if (ac !== state.abortController) return;

      // 清洗结果（兜底去引号/前缀）
      const cleaned = cleanResult(acc);
      if (cleaned !== acc) {
        acc = cleaned;
        state.result = acc;
        dom['result-text'].textContent = acc;
        updateCharCount(acc);
      }

      // 停止闪烁光标
      dom['result-text'].classList.add('done');

      // 存历史
      Store.addHistory({
        content: acc,
        scenario: state.scenario,
        reviewType: state.reviewType,
        wordCount: state.wordCount,
        platform: state.platform,
        keyword: state.keyword,
      });
    } catch (err) {
      if (ac !== state.abortController) return; // 过时流，忽略
      const isAbort = err && (err.type === 'aborted' || err.name === 'AbortError');
      if (!isAbort) {
        showError((err && err.message) || '生成失败，请重试');
      }
    } finally {
      // 仅当当前 ac 仍是自己时才重置状态（避免换一条后旧 finally 覆盖新状态）
      if (ac === state.abortController) {
        setState({ generating: false, abortController: null });
      }
    }
  }

  // 换一条：先 abort 当前，绕过防重入守卫，重新生成
  function onRegenerate() {
    // 若正在编辑，先退出编辑态
    if (state.editing) onEdit();
    if (state.abortController) state.abortController.abort();
    state.generating = false; // 直接置位，绕过 onGenerate 守卫，不触发 UI
    onGenerate();
  }

  /* ============================================================
   * 九、复制
   * ============================================================ */
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { /* 降级 */ }
    // 降级 execCommand
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
    // 从 DOM 取最新文本（编辑后可能与 state.result 不同步）
    const text = dom['result-text'].textContent;
    if (!text) return;
    const ok = await copyText(text);
    if (ok) {
      dom['btn-copy'].textContent = '已复制';
      toast('已复制到剪贴板');
      setTimeout(() => { dom['btn-copy'].textContent = '一键复制'; }, CONFIG.ui.copyToastMs);
    } else {
      toast('复制失败，请手动选择');
    }
  }

  /* ============================================================
   * 十、设置弹窗
   * ============================================================ */
  function openSettings() {
    dom['settings-apikey'].value = state.settings.apiKey || '';
    dom['settings-baseurl'].value = state.settings.baseUrl || '';
    dom['settings-model'].value = state.settings.model || CONFIG.api.defaultModel;
    dom['settings-overlay'].classList.remove('hidden');
  }

  function closeSettings() {
    dom['settings-overlay'].classList.add('hidden');
  }

  function saveSettings() {
    const apiKey = dom['settings-apikey'].value.trim();
    const baseUrl = dom['settings-baseurl'].value.trim();
    const model = dom['settings-model'].value.trim() || CONFIG.api.defaultModel;
    if (!apiKey) {
      toast('请填写 API Key');
      return;
    }
    Store.setSettings({ apiKey, baseUrl, model });
    setState({ settings: Store.getSettings() });
    closeSettings();
    toast('设置已保存');
  }

  /* ============================================================
   * 十一、历史记录侧边栏
   * ============================================================ */
  function openHistory() {
    renderHistory();
    dom['history-overlay'].classList.remove('hidden');
    dom['history-sidebar'].classList.add('sidebar-open');
  }

  function closeHistory() {
    dom['history-overlay'].classList.add('hidden');
    dom['history-sidebar'].classList.remove('sidebar-open');
  }

  function renderHistory() {
    const list = Store.getHistory();
    dom['history-list'].innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'text-sm text-gray-400 text-center py-10';
      empty.textContent = '暂无历史记录';
      dom['history-list'].appendChild(empty);
      return;
    }
    list.forEach((item) => {
      const card = document.createElement('div');
      card.className = 'rounded-xl bg-gray-50 dark:bg-[#2a2a2a] p-3 space-y-2';

      const meta = document.createElement('div');
      meta.className = 'flex items-center justify-between text-xs text-gray-400';
      meta.innerHTML = `<span>${labelOf(CONFIG.scenarios, item.scenario)} · ${labelOf(CONFIG.reviewTypes, item.reviewType)}</span><span>${formatTime(item.time)}</span>`;

      const content = document.createElement('p');
      content.className = 'text-sm leading-relaxed line-clamp-3';
      content.style.display = '-webkit-box';
      content.style.webkitLineClamp = '3';
      content.style.webkitBoxOrient = 'vertical';
      content.style.overflow = 'hidden';
      content.textContent = item.content;

      const actions = document.createElement('div');
      actions.className = 'flex gap-2';

      const btnCopy = document.createElement('button');
      btnCopy.className = 'flex-1 h-9 min-tap rounded-full bg-gray-200 dark:bg-gray-600 text-xs font-medium active:scale-95 transition';
      btnCopy.textContent = '复制';
      btnCopy.addEventListener('click', async () => {
        const ok = await copyText(item.content);
        toast(ok ? '已复制到剪贴板' : '复制失败，请手动选择');
      });

      const btnReuse = document.createElement('button');
      btnReuse.className = 'flex-1 h-9 min-tap rounded-full bg-brand text-white text-xs font-medium active:scale-95 transition';
      btnReuse.textContent = '复用';
      btnReuse.addEventListener('click', () => {
        // 回填 5 个参数
        setState({
          scenario: item.scenario,
          reviewType: item.reviewType,
          wordCount: item.wordCount,
          platform: item.platform,
          keyword: item.keyword || '',
        });
        dom['keyword-input'].value = item.keyword || '';
        closeHistory();
        window.scrollTo({ top: 0, behavior: 'smooth' });
        // 自动重新生成
        setTimeout(() => onGenerate(), 300);
      });

      actions.appendChild(btnCopy);
      actions.appendChild(btnReuse);
      card.appendChild(meta);
      card.appendChild(content);
      card.appendChild(actions);
      dom['history-list'].appendChild(card);
    });
  }

  function onClearHistory() {
    if (Store.getHistory().length === 0) { toast('暂无历史记录'); return; }
    if (!confirm('确定清空全部历史记录？此操作不可恢复。')) return;
    Store.clearHistory();
    renderHistory();
    toast('已清空历史记录');
  }

  /* ============================================================
   * 十二、暗黑模式
   * ============================================================ */
  function applyTheme() {
    const t = state.theme;
    const sysDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = t === 'dark' || (t === 'system' && sysDark);
    document.documentElement.classList.toggle('dark', dark);
    // 切换图标
    dom['icon-sun'].classList.toggle('hidden', dark);
    dom['icon-moon'].classList.toggle('hidden', !dark);
  }

  function toggleTheme() {
    const next = document.documentElement.classList.contains('dark') ? 'light' : 'dark';
    state.theme = next;
    Store.setTheme(next);
    applyTheme();
  }

  /* ============================================================
   * 十三、事件绑定
   * ============================================================ */
  function bindEvents() {
    // 关键词输入
    dom['keyword-input'].addEventListener('input', (e) => {
      state.keyword = e.target.value.replace(/[\r\n]+/g, ' ').trim();
    });

    // 生成 / 换一条 / 复制 / 编辑
    dom['btn-generate'].addEventListener('click', onGenerate);
    dom['btn-regenerate'].addEventListener('click', onRegenerate);
    dom['btn-copy'].addEventListener('click', onCopy);
    dom['btn-edit'].addEventListener('click', onEdit);

    // 结果区编辑时实时更新字数
    dom['result-text'].addEventListener('input', () => {
      if (state.editing) updateCharCount(dom['result-text'].textContent);
    });

    // 设置弹窗
    dom['btn-settings'].addEventListener('click', openSettings);
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

    // 暗黑模式
    dom['btn-theme'].addEventListener('click', toggleTheme);
    // 跟随系统变化
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (state.theme === 'system') applyTheme();
    });

    // 移动端键盘弹出时，关键词输入框滚动到可视区
    dom['keyword-input'].addEventListener('focus', () => {
      setTimeout(() => dom['keyword-input'].scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
    });

    // ESC 关闭弹窗/侧边栏
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!dom['settings-overlay'].classList.contains('hidden')) closeSettings();
      if (!dom['history-overlay'].classList.contains('hidden')) closeHistory();
    });
  }

  /* ============================================================
   * 十四、初始化
   * ============================================================ */
  function init() {
    cacheDom();
    initDefaults();
    renderTags();
    updatePlaceholder();
    renderQuickKeywords();
    updateGenerateBtn();
    applyTheme();
    bindEvents();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
