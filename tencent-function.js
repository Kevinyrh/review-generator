/**
 * 腾讯云函数版 - DeepSeek API 代理
 * 运行环境：Node.js 16.13+（使用 https 模块，不依赖 fetch）
 * 
 * 部署步骤：
 * 1. 腾讯云 → 云函数 → 新建 → Node.js 16.13+ → 粘贴本代码
 * 2. 函数配置 → 环境变量 → DEEPSEEK_API_KEY = 你的key
 * 3. 函数URL → 新建 → 授权类型选「开放」→ CORS 开启
 */

const https = require('https');

const DEEPSEEK_BASE = 'https://api.deepseek.com';
const DEEPSEEK_PATH = '/v1/chat/completions';

// 只允许你的网页调用（防滥用）
const ALLOWED_ORIGINS = [
  'https://kevinyrh.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

// 封装 https 请求为 Promise
function httpsRequest(url, options, bodyStr) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body: data,
        });
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

exports.main_handler = async (event) => {
  const httpInfo = event || {};
  const headers = httpInfo.headers || {};
  const origin = headers.origin || headers.Origin || '';

  // CORS 预检
  if ((httpInfo.httpMethod || '').toUpperCase() === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400',
      },
      body: '',
    };
  }

  // 来源检查
  if (ALLOWED_ORIGINS.length > 0 && !ALLOWED_ORIGINS.includes(origin)) {
    return {
      statusCode: 403,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '来源不在白名单' }),
    };
  }

  // 解析请求体
  let body;
  try {
    body = typeof httpInfo.body === 'string' ? JSON.parse(httpInfo.body) : httpInfo.body;
  } catch (e) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '请求体解析失败' }),
    };
  }

  // 转发到 DeepSeek
  try {
    const bodyStr = JSON.stringify(body);
    const resp = await httpsRequest(DEEPSEEK_BASE, {
      method: 'POST',
      path: DEEPSEEK_PATH,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`,
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, bodyStr);

    const respHeaders = {
      'Content-Type': resp.headers['content-type'] || 'application/json',
      'Access-Control-Allow-Origin': '*',
    };
    if (body.stream) {
      respHeaders['Cache-Control'] = 'no-cache';
    }

    return {
      statusCode: resp.statusCode,
      headers: respHeaders,
      body: resp.body,
    };
  } catch (e) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
      body: JSON.stringify({ error: '代理请求失败: ' + e.message }),
    };
  }
};
