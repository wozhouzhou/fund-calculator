const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── 交易所前缀判断 ──────────────────────────────
function getExchangePrefix(code) {
  if (!code || code.length !== 6) return null;
  if (code.startsWith('15') || code.startsWith('16')) return 'sz';
  if (code.startsWith('51') || code.startsWith('56') || code.startsWith('58')) return 'sh';
  return null; // 普通基金（非ETF）
}

// ─── 当天日期 YYYY-MM-DD ─────────────────────────
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ─── 1. 新浪股票实时行情（ETF 用）────────────────
async function fetchFromSina(code, prefix) {
  const url = `https://hq.sinajs.cn/list=${prefix}${code}`;
  const resp = await axios.get(url, {
    headers: {
      'Referer': 'https://finance.sina.com.cn',
      'Accept': '*/*'
    },
    timeout: 8000,
    responseType: 'arraybuffer'
  });

  // 新浪返回 GBK 编码，用 iconv 解码
  let text;
  try {
    const iconv = require('iconv-lite');
    text = iconv.decode(Buffer.from(resp.data), 'GBK');
  } catch (e) {
    // iconv 不可用时尝试 utf-8
    text = Buffer.from(resp.data).toString('utf-8');
  }

  const match = text.match(/"([^"]+)"/);
  if (!match) return null;

  const fields = match[1].split(',');
  if (!fields || fields.length < 10) return null;

  const name = fields[0] || '';
  const open = parseFloat(fields[1]) || 0;
  const prevClose = parseFloat(fields[2]) || 0;
  const current = parseFloat(fields[3]) || 0;

  if (!current || !prevClose) return null;

  const change = current - prevClose;
  const changePercent = (change / prevClose) * 100;

  return {
    code,
    name: name.replace(/[\x00-\x1f]/g, ''), // 去除控制字符
    price: current,
    prevClose,
    open,
    high: parseFloat(fields[4]) || 0,
    low: parseFloat(fields[5]) || 0,
    change: Math.round(change * 10000) / 10000,
    changePercent: Math.round(changePercent * 100) / 100,
    source: 'sina',
    time: new Date().toLocaleString('zh-CN', { hour12: false })
  };
}

function parseSinaFields(code, fields) {
  if (!fields || fields.length < 10) return null;

  const name = fields[0] || '';
  const open = parseFloat(fields[1]) || 0;
  const prevClose = parseFloat(fields[2]) || 0;
  const current = parseFloat(fields[3]) || 0;
  const high = parseFloat(fields[4]) || 0;
  const low = parseFloat(fields[5]) || 0;

  if (!current || !prevClose) return null;

  const change = current - prevClose;
  const changePercent = (change / prevClose) * 100;

  return {
    code,
    name: name.replace(/[\x00-\x1f]/g, ''), // 去除控制字符
    price: current,
    prevClose,
    open,
    high,
    low,
    change: Math.round(change * 10000) / 10000,
    changePercent: Math.round(changePercent * 100) / 100,
    source: 'sina',
    time: new Date().toLocaleString('zh-CN', { hour12: false })
  };
}

// ─── 2. 天天基金实时估值（所有基金通用）───────────
async function fetchFromEastMoney(code) {
  const url = `https://fundgz.1234567.com.cn/js/${code}.js`;
  const resp = await axios.get(url, {
    headers: {
      'Referer': 'https://fund.eastmoney.com',
      'Accept': '*/*'
    },
    timeout: 8000,
    responseType: 'text'
  });

  const jsonMatch = resp.data.match(/jsonpgz\(([\s\S]+)\)/);
  if (!jsonMatch) return null;

  const data = JSON.parse(jsonMatch[1]);
  const prevClose = parseFloat(data.dwjz || data.dzjz || 0); // 昨日净值
  const gsz = parseFloat(data.gsz || 0);                     // 估算净值
  const gszzl = parseFloat(data.gszzl || data.gz || 0);      // 估算涨幅%

  if (!prevClose) return null;

  return {
    code: data.fundcode,
    name: data.name || '',
    price: gsz || prevClose,
    prevClose: prevClose,
    change: gsz ? Math.round((gsz - prevClose) * 10000) / 10000 : 0,
    changePercent: gszzl || 0,
    source: 'eastmoney',
    time: data.gztime || new Date().toLocaleString('zh-CN', { hour12: false })
  };
}

// ─── 3. 基金基础信息（名称等）─────────────────────
async function fetchFundInfo(code) {
  // 先尝试天天基金信息页
  try {
    const url = `https://fund.eastmoney.com/pingzhongdata/${code}.js`;
    const resp = await axios.get(url, {
      headers: { 'Referer': 'https://fund.eastmoney.com' },
      timeout: 10000,
      responseType: 'text'
    });
    const text = resp.data;

    // 提取基金名称
    const nameMatch = text.match(/fS_name\s*=\s*["']([^"']+)["']/);
    const codeMatch = text.match(/fS_code\s*=\s*["']([^"']+)["']/);
    const typeMatch = text.match(/fS_typename\s*=\s*["']([^"']+)["']/);

    return {
      code: codeMatch ? codeMatch[1] : code,
      name: nameMatch ? nameMatch[1] : '',
      type: typeMatch ? typeMatch[1] : ''
    };
  } catch (e) {
    // fallback: 从 fundgz 获取名称
    try {
      const quote = await fetchFromEastMoney(code);
      if (quote) {
        return { code, name: quote.name, type: '' };
      }
    } catch (e2) {}
    return { code, name: '', type: '' };
  }
}

// ─── API: 获取实时行情 ────────────────────────────
app.get('/api/quote/:code', async (req, res) => {
  const { code } = req.params;

  try {
    const prefix = getExchangePrefix(code);
    let data = null;

    // ETF 优先用新浪实时行情
    if (prefix) {
      try {
        data = await fetchFromSina(code, prefix);
      } catch (e) {
        console.log(`Sina fetch failed for ${code}: ${e.message}, trying EastMoney...`);
      }
    }

    // 回退到天天基金估值
    if (!data) {
      try {
        data = await fetchFromEastMoney(code);
      } catch (e) {
        console.log(`EastMoney fetch failed for ${code}: ${e.message}`);
      }
    }

    if (data) {
      return res.json(data);
    }

    res.status(404).json({ error: `无法获取基金 ${code} 的行情数据` });
  } catch (err) {
    console.error(`Error fetching ${code}:`, err.message);
    res.status(500).json({ error: `数据获取失败: ${err.message}` });
  }
});

// ─── API: 批量获取行情 ────────────────────────────
app.post('/api/quotes', async (req, res) => {
  const codes = req.body?.codes || [];
  if (!codes.length) {
    return res.json({ results: [] });
  }

  const uniqueCodes = [...new Set(codes)];
  const results = await Promise.allSettled(
    uniqueCodes.map(async (code) => {
      const prefix = getExchangePrefix(code);
      let data = null;

      if (prefix) {
        try { data = await fetchFromSina(code, prefix); } catch (e) {}
      }
      if (!data) {
        try { data = await fetchFromEastMoney(code); } catch (e) {}
      }
      return data || { code, name: '', price: 0, prevClose: 0, change: 0, changePercent: 0, error: '无数据' };
    })
  );

  res.json({
    results: results.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message })
  });
});

// ─── API: 获取基金基本信息 ────────────────────────
app.get('/api/fund/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const info = await fetchFundInfo(code);
    res.json(info);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── 启动 ─────────────────────────────────────────
app.listen(PORT, HOST, () => {
  console.log(`\n  📊 实时基金盈亏计算器已启动`);
  console.log(`  ─────────────────────────────`);
  console.log(`  本地地址: http://localhost:${PORT}`);
  console.log(`  示例: http://localhost:${PORT}/?demo=1  (带演示数据)\n`);
});
