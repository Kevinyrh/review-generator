/**
 * DeepSeek API 代理 - Cloudflare Worker
 * 
 * 作用：把你的 DeepSeek API Key 藏在云函数环境变量里，
 * 朋友打开网页不需要配 key，请求经此函数转发到 DeepSeek。
 * 
 * 部署步骤见下方说明。
 */

// 只允许这些来源调用（防止别人盗用你的 Worker）
const ALLOWED_ORIGINS = [
  'https://kevinyrh.github.io',    // 你的 GitHub Pages
  'http://localhost:8000',          // 本地测试用
];

const DEEPSEEK_BASE = 'https://api.deepseek.com/v1';

export default {
  async fetch(request, env) {
    // CORS 预检请求
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        },
      });
    }

    // 只允许 POST
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: '仅支持 POST 请求' }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // 来源检查（防滥用：只有你的网页能调用）
    const origin = request.headers.get('Origin') || '';
    if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
      return new Response(JSON.stringify({ error: '来源不在白名单' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }

    try {
      const body = await request.json();

      // 转发到 DeepSeek，注入 API Key（从环境变量读取，不在代码里）
      const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${env.DEEPSEEK_API_KEY}`,
        },
        body: JSON.stringify(body),
      });

      // 流式转发响应（保持 SSE 流式输出）
      const respHeaders = new Headers();
      respHeaders.set('Content-Type', resp.headers.get('Content-Type') || 'application/json');
      respHeaders.set('Access-Control-Allow-Origin', '*');
      // 流式响应需要这些头
      if (body.stream) {
        respHeaders.set('Cache-Control', 'no-cache');
        respHeaders.set('Connection', 'keep-alive');
      }

      return new Response(resp.body, {
        status: resp.status,
        headers: respHeaders,
      });
    } catch (e) {
      return new Response(JSON.stringify({ error: '代理请求失败: ' + e.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      });
    }
  },
};
