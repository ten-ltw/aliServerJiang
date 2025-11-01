const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

// ========== 配置 ==========
const CONFIG = {
  maxStoredIds: 90,
  idStorageFile: "processed_ids.json",
  loopInterval: 30000, // 30秒循环间隔
  urls: [
    {
      name: "纸袋",
      url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.14.68ff65aaNkrl5H&categoryIds=201271492&recently=Y",
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=691cd204-4530-4cec-a5f2-c20d53c7b500",
    },
    {
      name: "标签",
      url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.4ad465aaP5FXb9&categoryIds=201726904&recently=Y",
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=63d28aab-5e65-4273-ab0d-398cf430790b",
    },
    {
      name: "卡片",
      url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.6b0e65aaFBblYX&categoryIds=100002844&recently=Y",
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=4aa70d53-ac0f-49cc-b410-43af270fc07e",
    },
  ],
};

// ========== ID 管理类 ==========
class IDManager {
  constructor(filePath, maxSize) {
    this.filePath = filePath;
    this.maxSize = maxSize;
    this.ids = this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        return JSON.parse(data);
      }
    } catch (error) {
      console.error("读取ID文件失败:", error.message);
    }
    return [];
  }

  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.ids, null, 2), "utf-8");
    } catch (error) {
      console.error("保存ID文件失败:", error.message);
    }
  }

  exists(id) {
    return this.ids.includes(id);
  }

  add(id) {
    if (!this.exists(id)) {
      this.ids.unshift(id);
      if (this.ids.length > this.maxSize) {
        this.ids.pop();
      }
      this.save();
      return true;
    }
    return false;
  }
}

// ========== Unicode 解码 ==========
function decodeUnicodeEscapes(str) {
  str = str.replace(/\\x([0-9A-Fa-f]{2})/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  str = str.replace(/\\u([0-9A-Fa-f]{4})/g, (match, hex) => {
    return String.fromCharCode(parseInt(hex, 16));
  });
  return str;
}

// ========== 提取页面数据 ==========
function extractPageData(scriptContent) {
  try {
    const quantityMatch = scriptContent.match(/quantity:\s*"?(\d+)"?/);
    const quantity = quantityMatch ? parseInt(quantityMatch[1]) : null;

    const subjectMatch = scriptContent.match(/subject:\s*"([^"]+)"/);
    const subject = subjectMatch ? subjectMatch[1] : null;

    const enDescMatch = scriptContent.match(/enDescription:\s*"([^"]*)"/);
    let enDescription = enDescMatch ? enDescMatch[1] : null;

    if (enDescription) {
      enDescription = enDescription
        .replace(/\\r\\n/g, " ")
        .replace(/\\n/g, " ")
        .replace(/\\r/g, " ")
        .replace(/\\t/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/\\\\/g, "\\")
        .replace(/\s+/g, " ")
        .trim();
    }

    return { success: true, data: { quantity, subject, enDescription } };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ========== 获取详情页数据 ==========
async function fetchDetailHTML(url, itemId) {
  try {
    let fullUrl = url.startsWith("//") ? "https:" + url : url.startsWith("http") ? url : "https://" + url;

    const response = await axios.get(fullUrl, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    let targetScript = null;

    $("script").each((index, element) => {
      const content = $(element).html() || "";
      if (content.includes("PAGE_DATA") && content.includes("userType")) {
        targetScript = content;
        return false;
      }
    });

    if (!targetScript) {
      return { success: false, error: "未找到目标脚本", url: fullUrl };
    }

    const decodedScript = decodeUnicodeEscapes(targetScript);
    const extractResult = extractPageData(decodedScript);

    if (extractResult.success) {
      return {
        success: true,
        url: fullUrl,
        quantity: extractResult.data.quantity,
        subject: extractResult.data.subject,
        enDescription: extractResult.data.enDescription,
      };
    } else {
      return { success: false, error: extractResult.error, url: fullUrl };
    }
  } catch (error) {
    return { success: false, error: error.message, url: url };
  }
}

// ========== 发送企业微信消息 ==========
async function sendWeworkMessage(messageData, webhookUrl) {
  const levelImages = {
    1: "https://img.alicdn.com/imgextra/i2/O1CN01B4pKUX1tIdHA9HOvG_!!6000000005879-2-tps-294-60.png",
    2: "https://img.alicdn.com/imgextra/i3/O1CN01vBjGY61VoBhRLyKX5_!!6000000002699-2-tps-279-60.png",
    3: "https://img.alicdn.com/imgextra/i1/O1CN01xqZ7i21uEnURLYxcU_!!6000000006006-2-tps-279-60.png",
  };

  const levelImage = levelImages[messageData.rfqStarLevel];
  const contentPreview = messageData.description.length > 200 
    ? messageData.description.substring(0, 200) + "..." 
    : messageData.description;

  const markdownContent = `
##### ${messageData.subject}
![等级](${levelImage})
**数量:** ${messageData.quantity}
**来源:** ${messageData.country}
**内容描述:** ${contentPreview}[阅读详情](${messageData.url})
  `.trim();

  try {
    const response = await axios.post(webhookUrl, {
      msgtype: "markdown_v2",
      markdown_v2: { content: markdownContent },
    });

    return response.data.errcode === 0 
      ? { success: true } 
      : { success: false, error: response.data.errmsg };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// ========== 发送给客户 ==========
async function sendToClient(item, webhook) {
  // const result = await fetchDetailHTML(item.url, item.id);
  // result.rfqStarLevel = item.rfqStarLevel;
  // result.country = item.country;
  await sendWeworkMessage(item, webhook);
  return true;
}

// ========== 爬取单个URL ==========
async function scrapeOneURL(urlConfig, idManager) {
  const stats = { total: 0, duplicate: 0, new: 0, sent: 0, failed: 0 };

  try {
    const response = await axios.get(urlConfig.url, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
      timeout: 10000,
    });

    const $ = cheerio.load(response.data);
    let targetScript = null;

    $("script").each((index, element) => {
      const content = $(element).html() || "";
      if (content.includes("PAGE_DATA") && content.includes("uuid")) {
        targetScript = content;
        return false;
      }
    });

    if (!targetScript) return stats;

    const decodedScript = decodeUnicodeEscapes(targetScript);
    const pushRegex = /window\.PAGE_DATA\["index"\]\.data\.push\((\{[\s\S]*?\})\);/g;
    const matches = [...decodedScript.matchAll(pushRegex)];

    stats.total = matches.length;

    for (let i = 0; i < matches.length; i++) {
      try {
        let objStr = matches[i][1];

        const urlMatch = objStr.match(/url:\s*"([^"]+)"/);
        let url = urlMatch ? urlMatch[1] : "";

        const idMatch = objStr.match(/id:\s*"([^"]+)"/);
        const id = idMatch ? idMatch[1] : "";

        // const starLevelMatch = objStr.match(/rfqStarLevel:\s*parseInt\("(\d+)"/);
        // const rfqStarLevel = starLevelMatch ? parseInt(starLevelMatch[1]) : 0;

        let rfqStarLevel = 0;
        const tagsMatch = objStr.match(/tags:\s*(\[[\s\S]*?\])\s*\|\|/);
        
        if (tagsMatch) {
          const tagMatch = tagsMatch[1].match(/\{"tagName":"([^"]+)","type":"rfq_level"/);
          if (tagMatch) {
            const tagName = tagMatch[1];
            // 映射表
            const levelMap = {
              'RFQ_MKT_ST_28102': 2,//银牌
              'RFQ_MKT_ST_28101': 3,//铜牌
              'RFQ_MKT_ST_39408': 1,//金牌
            };
            rfqStarLevel = levelMap[tagName] || 0;
          }
        }

        const openTimeMatch = objStr.match(/openTimeStr:\s*"([^"]+)"/);
        const openTimeStr = openTimeMatch ? openTimeMatch[1] : "";

        const countryMatch = objStr.match(/country:\s*"([^"]*)"/);
        const country = countryMatch ? countryMatch[1] : "";

        const quantityMatch = objStr.match(/quantity:\s*'([^']*)'/);
        const quantity = quantityMatch ? quantityMatch[1] : "";

        const descriptionMatch = objStr.match(/description:\s*"([^"]*)"/);
        const description = descriptionMatch ? descriptionMatch[1] : "";

        const subjectMatch = objStr.match(/subject:\s*"([^"]*)"/);
        const subject = subjectMatch ? subjectMatch[1] : "";

        url = url.startsWith("//") ? "https:" + url : url.startsWith("http") ? url : "https://" + url;

        const item = { id, url, rfqStarLevel, openTimeStr, country, quantity, description, subject };

        if (idManager.exists(id)) {
          stats.duplicate++;
          continue;
        }

        stats.new++;

        try {
          await sendToClient(item, urlConfig.webhook);
          stats.sent++;
          idManager.add(id);
        } catch (error) {
          stats.failed++;
        }
      } catch (error) {
        console.error(`解析数据失败: ${error.message}`);
      }
    }
  } catch (error) {
    console.error(`爬取失败: ${error.message}`);
  }

  return stats;
}

// ========== 主函数 ==========
async function scrapeAllURLs() {
  const idManager = new IDManager(CONFIG.idStorageFile, CONFIG.maxStoredIds);
  const totalStats = { total: 0, duplicate: 0, new: 0, sent: 0, failed: 0 };

  for (let i = 0; i < CONFIG.urls.length; i++) {
    const urlConfig = CONFIG.urls[i];
    const stats = await scrapeOneURL(urlConfig, idManager);

    totalStats.total += stats.total;
    totalStats.duplicate += stats.duplicate;
    totalStats.new += stats.new;
    totalStats.sent += stats.sent;
    totalStats.failed += stats.failed;

    console.log(`${urlConfig.name}: 发现 ${stats.new} 条新数据，已发送 ${stats.sent} 条`);

    if (i < CONFIG.urls.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log(`\n总计: 新数据 ${totalStats.new} 条，成功发送 ${totalStats.sent} 条，失败 ${totalStats.failed} 条`);
}

// ========== 循环服务 ==========
async function startService() {
  console.log(`服务启动 - 每 ${CONFIG.loopInterval / 1000} 秒执行一次\n`);
  
  let runCount = 0;
  
  while (true) {
    try {
      runCount++;
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      console.log(`[${now}] 第 ${runCount} 次执行开始`);
      
      await scrapeAllURLs();
      
      console.log(`等待 ${CONFIG.loopInterval / 1000} 秒后继续...\n`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.loopInterval));
    } catch (error) {
      console.error(`执行出错: ${error.message}`);
      console.log(`等待 ${CONFIG.loopInterval / 1000} 秒后重试...\n`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.loopInterval));
    }
  }
}

// ========== 执行 ==========
startService();
