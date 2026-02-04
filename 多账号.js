const DEFAULT_CONFIG = {
  DOMAIN: 'https://ikuuu.nl',
  ACCOUNTS: [],
  TRIGGER_PATH: '/auto-checkin',
  TG_BOT_TOKEN: '',
  TG_CHAT_ID: '',
  SC_KEY: '',  // 新增：Server酱的SCU密钥
  MAX_RETRY: 3
};

let config = { ...DEFAULT_CONFIG };

export default {
  async fetch(request, env, ctx) {
    await initializeConfig(env);
    const url = new URL(request.url);
    
    if (url.pathname === config.TRIGGER_PATH) {
      try {
        const results = await checkAllAccounts();
        const message = `✅ 自动签到完成\n${results.join('\n')}`;
        console.log(message);
        
        // 同时发送Telegram和Server酱通知
        await Promise.allSettled([
          sendTelegramNotification(message),
          sendServerChanNotification(message)
        ]);
        
        return successResponse(results.join('\n'));
      } catch (error) {
        console.error('签到失败:', error);
        const errorMessage = `❌ 自动签到失败\n${error.message}`;
        
        // 同时发送错误通知
        await Promise.allSettled([
          sendTelegramNotification(errorMessage),
          sendServerChanNotification(errorMessage)
        ]);
        
        return errorResponse(error);
      }
    }
    else if (url.pathname === '/') {
      return new Response(
        `请访问 ${config.TRIGGER_PATH} 触发签到\n\n已配置通知方式：\n` +
        `${config.TG_BOT_TOKEN ? '✅ Telegram通知\n' : '❌ Telegram通知\n'}` +
        `${config.SC_KEY ? '✅ Server酱通知\n' : '❌ Server酱通知\n'}`,
        { 
          status: 200,
          headers: { 
            'Content-Type': 'text/plain; charset=UTF-8',
            'X-Content-Type-Options': 'nosniff'
          }
        }
      );
    }    
    return new Response('Not Found', { status: 404 });
  },

  async scheduled(event, env, ctx) {
    await initializeConfig(env);
    console.log('Cron job started at:', new Date().toISOString());
    
    try {
      const results = await checkAllAccounts();
      const message = `✅ 定时签到完成\n${results.join('\n')}`;
      console.log('Cron job succeeded:', results);
      
      // 同时发送Telegram和Server酱通知
      await Promise.allSettled([
        sendTelegramNotification(message),
        sendServerChanNotification(message)
      ]);
      
    } catch (error) {
      console.error('Cron job failed:', error);
      const errorMessage = `❌ 定时签到失败\n${error.message}`;
      
      // 同时发送错误通知
      await Promise.allSettled([
        sendTelegramNotification(errorMessage),
        sendServerChanNotification(errorMessage)
      ]);
    }
  }
};

async function initializeConfig(env) {
  config = {
    DOMAIN: env.DOMAIN || config.DOMAIN,
    ACCOUNTS: env.ACCOUNTS ? env.ACCOUNTS.split('&').reduce((acc, cur, i, arr) => {
      if (i % 2 === 0 && arr[i + 1]) {
        acc.push({ 
          email: cur.trim(), 
          password: arr[i + 1].trim() 
        });
      }
      return acc;
    }, []) : config.ACCOUNTS,
    TRIGGER_PATH: env.TRIGGER_PATH || config.TRIGGER_PATH,
    TG_BOT_TOKEN: env.TG_BOT_TOKEN || config.TG_BOT_TOKEN,
    TG_CHAT_ID: env.TG_CHAT_ID || config.TG_CHAT_ID,
    SC_KEY: env.SC_KEY || config.SC_KEY,  // 读取Server酱密钥
    MAX_RETRY: env.MAX_RETRY ? parseInt(env.MAX_RETRY) : config.MAX_RETRY
  };
  
  console.log('配置初始化完成:', {
    domain: config.DOMAIN,
    accountCount: config.ACCOUNTS.length,
    telegramBot: !!config.TG_BOT_TOKEN,
    serverChan: !!config.SC_KEY
  });
}

async function checkAllAccounts() {
  if (!config.ACCOUNTS.length) throw new Error('未配置签到账户');

  const results = [];
  for (const account of config.ACCOUNTS) {
    try {
      const result = await withRetry(() => checkin(account), config.MAX_RETRY);
      results.push(`📧 ${maskString(account.email)} 签到成功：${result}`);
    } catch (error) {
      results.push(`❌ ${maskString(account.email)} 签到失败：${error.message}`);
    }
  }
  return results;
}

async function checkin(account) {
  console.log(`[${account.email}] 开始签到流程...`);
  
  // 尝试两个可能的域名
  const domainsToTry = [config.DOMAIN];
  if (config.DOMAIN.includes('ikuuu.nl')) {
    domainsToTry.push('https://ikuuu.fyi');
  }
  
  let lastError = null;
  
  for (const domain of domainsToTry) {
    try {
      console.log(`[${account.email}] 尝试使用域名: ${domain}`);
      
      // 登录
      const loginResponse = await fetch(`${domain}/auth/login`, {
        method: 'POST',
        headers: createHeaders('login', domain),
        body: JSON.stringify({ 
          email: account.email, 
          passwd: account.password,
          code: '', // 如果有验证码需要添加
          remember_me: true
        })
      });
      
      const loginResult = await loginResponse.json();
      console.log(`[${account.email}] 登录响应:`, JSON.stringify(loginResult));
      
      if (!loginResponse.ok) {
        throw new Error(`登录失败: ${loginResult.msg || loginResponse.statusText}`);
      }
      
      if (loginResult.ret !== 1 && loginResult.ret !== 0) {
        throw new Error(`登录返回异常: ${loginResult.msg || '未知错误'}`);
      }
      
      // 获取cookies
      const cookies = parseCookies(loginResponse.headers);
      console.log(`[${account.email}] 获取到cookies:`, cookies ? '有' : '无');
      
      if (!cookies) {
        throw new Error('未获取到登录cookie');
      }
      
      await delay(1500); // 等待更长时间确保会话建立
      
      // 签到
      const checkinResponse = await fetch(`${domain}/user/checkin`, {
        method: 'POST',
        headers: createHeaders('checkin', domain, cookies),
        body: null
      });
      
      const checkinResult = await checkinResponse.json();
      console.log(`[${account.email}] 签到响应:`, JSON.stringify(checkinResult));
      
      if (!checkinResponse.ok) {
        throw new Error(`签到请求失败: ${checkinResult.msg || checkinResponse.statusText}`);
      }
      
      if (checkinResult.ret === 1) {
        // 签到成功
        return checkinResult.msg || '签到成功';
      } else if (checkinResult.ret === 0) {
        // 可能已经签到过
        return checkinResult.msg || '今日已签到';
      } else {
        throw new Error(checkinResult.msg || '签到返回异常');
      }
      
    } catch (error) {
      console.error(`[${account.email}] 使用域名 ${domain} 失败:`, error.message);
      lastError = error;
      continue; // 尝试下一个域名
    }
  }
  
  throw lastError || new Error('所有域名尝试均失败');
}

async function sendTelegramNotification(message) {
  if (!config.TG_BOT_TOKEN || !config.TG_CHAT_ID) {
    console.log('未配置Telegram通知，跳过发送');
    return;
  }

  const timeString = new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    hour12: false 
  });

  const payload = {
    chat_id: config.TG_CHAT_ID,
    text: `🕒 执行时间: ${timeString}\n` +
          `🌐 机场地址: ${maskString(config.DOMAIN)}\n` +
          `📥 签到账户数: ${config.ACCOUNTS.length}\n\n` +
          `${Array.isArray(message) ? message.join('\n') : message}`,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  };

  const telegramAPI = `https://api.telegram.org/bot${config.TG_BOT_TOKEN}/sendMessage`;
  
  try {
    const response = await fetch(telegramAPI, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      console.error('Telegram通知失败:', await response.text());
    } else {
      console.log('Telegram通知发送成功');
    }
  } catch (error) {
    console.error('Telegram通知异常:', error);
  }
}

// 新增：发送Server酱通知的函数
async function sendServerChanNotification(message) {
  if (!config.SC_KEY) {
    console.log('未配置Server酱通知，跳过发送');
    return;
  }

  const timeString = new Date().toLocaleString('zh-CN', { 
    timeZone: 'Asia/Shanghai',
    hour12: false 
  });

  // 构建Server酱通知内容
  const title = 'iKuuu自动签到通知';
  
  // 消息内容
  let desp = `**执行时间**: ${timeString}\n\n`;
  desp += `**机场地址**: ${maskString(config.DOMAIN)}\n\n`;
  desp += `**签到账户数**: ${config.ACCOUNTS.length}\n\n`;
  desp += `---\n\n`;
  
  if (Array.isArray(message)) {
    desp += message.join('\n\n');
  } else {
    desp += message;
  }
  
  // 添加签名和时间戳
  desp += `\n\n---\n*来自 iKuuu 自动签到脚本*`;
  
  const serverChanAPI = `https://sctapi.ftqq.com/${config.SC_KEY}.send`;
  
  try {
    // 新版Server酱API
    const payload = {
      title: title,
      desp: desp
    };
    
    // 使用URL编码方式发送
    const formData = new FormData();
    formData.append('title', title);
    formData.append('desp', desp);
    
    const response = await fetch(serverChanAPI, {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    
    if (result.code === 0) {
      console.log('Server酱通知发送成功:', result.data.pushid);
    } else {
      console.error('Server酱通知失败:', result.message);
    }
    
  } catch (error) {
    console.error('Server酱通知异常:', error);
    
    // 如果新版API失败，尝试旧版API格式
    try {
      const oldAPI = `https://sc.ftqq.com/${config.SC_KEY}.send`;
      const oldResponse = await fetch(oldAPI, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          text: title,
          desp: desp
        })
      });
      
      const oldResult = await oldResponse.json();
      
      if (oldResult.errno === 0) {
        console.log('Server酱旧版API通知发送成功');
      } else {
        console.error('Server酱旧版API通知失败:', oldResult.errmsg);
      }
    } catch (oldError) {
      console.error('Server酱旧版API也失败了:', oldError);
    }
  }
}

function maskString(str, visibleStart = 2, visibleEnd = 2) {
  if (!str) return '';
  if (str.length <= visibleStart + visibleEnd) return str;
  const maskedLength = str.length - visibleStart - visibleEnd;
  const maskedChars = '*'.repeat(Math.min(maskedLength, 4)); // 最多显示4个*
  return `${str.substring(0, visibleStart)}${maskedChars}${str.substring(str.length - visibleEnd)}`;
}

function createHeaders(type = 'default', domain, cookie = '') {
  const common = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    'Origin': domain,
    'Connection': 'keep-alive',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin'
  };

  const headers = {
    login: {
      ...common,
      'Content-Type': 'application/json',
      'Referer': `${domain}/auth/login`
    },
    checkin: {
      ...common,
      'Content-Type': 'application/json;charset=UTF-8',
      'Referer': `${domain}/user`,
      'X-Requested-With': 'XMLHttpRequest'
    }
  };

  const result = headers[type] || common;
  
  // 如果有cookie，添加Cookie头
  if (cookie) {
    result.Cookie = cookie;
  }
  
  return result;
}

function parseCookies(headers) {
  const setCookie = headers.get('set-cookie') || headers.get('Set-Cookie');
  if (!setCookie) return '';
  
  // 处理多个cookie的情况
  const cookies = [];
  if (Array.isArray(setCookie)) {
    for (const cookie of setCookie) {
      const cookieStr = typeof cookie === 'string' ? cookie : String(cookie);
      cookies.push(cookieStr.split(';')[0].trim());
    }
  } else {
    // 如果是字符串，按逗号分割，但要注意日期中的逗号
    const cookieStrings = setCookie.split(/(?=,\s*[A-Za-z0-9_-]+=)/);
    for (const cookieStr of cookieStrings) {
      cookies.push(cookieStr.replace(/^,\s*/, '').split(';')[0].trim());
    }
  }
  
  // 过滤空值并去重
  const uniqueCookies = [...new Set(cookies.filter(c => c))];
  return uniqueCookies.join('; ');
}

async function withRetry(fn, retries) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      console.log(`重试 ${i + 1}/${retries} 失败:`, error.message);
      if (i === retries - 1) throw error;
      await delay(3000 * (i + 1)); // 指数退避
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function successResponse(data) {
  return new Response(data, { 
    status: 200, 
    headers: { 
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-cache'
    } 
  });
}

function errorResponse(error) {
  return new Response(`错误: ${error.message}`, { 
    status: 500, 
    headers: { 
      'Content-Type': 'text/plain; charset=UTF-8',
      'Cache-Control': 'no-cache'
    } 
  });
}