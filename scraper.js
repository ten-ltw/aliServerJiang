const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");

// ========== 配置 ==========
const CONFIG = {
  maxStoredIds: 25, // 每个类别保存25条
  loopInterval: 30000,
  urls: [
    {
      name: "纸袋",
      idFile: "processed_ids_paper_bag.json", // 独立的ID文件
      url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.14.68ff65aaNkrl5H&categoryIds=201271492&recently=Y",
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=691cd204-4530-4cec-a5f2-c20d53c7b500",
    },
    {
      name: "标签",
      idFile: "processed_ids_label.json", // 独立的ID文件
      url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.4ad465aaP5FXb9&categoryIds=201726904&recently=Y",
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=63d28aab-5e65-4273-ab0d-398cf430790b",
    },
    {
      name: "卡片",
      idFile: "processed_ids_card.json", // 独立的ID文件
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
    this.saveTimer = null;
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = fs.readFileSync(this.filePath, "utf-8");
        const parsed = JSON.parse(data);
        
        if (Array.isArray(parsed)) {
          console.log(`✓ [${this.filePath}] 加载了 ${parsed.length} 个已处理ID`);
          return parsed;
        }
      }
    } catch (error) {
      console.error(`❌ 读取ID文件失败 [${this.filePath}]:`, error.message);
      if (fs.existsSync(this.filePath)) {
        const backupPath = `${this.filePath}.backup.${Date.now()}`;
        fs.copyFileSync(this.filePath, backupPath);
        console.log(`已备份损坏文件到: ${backupPath}`);
      }
    }
    return [];
  }

  saveSync() {
    try {
      const data = JSON.stringify(this.ids, null, 2);
      const tempPath = `${this.filePath}.tmp`;
      fs.writeFileSync(tempPath, data, "utf-8");
      fs.renameSync(tempPath, this.filePath);
      console.log(`✓ [${this.filePath}] 已保存 ${this.ids.length} 个ID`);
    } catch (error) {
      console.error(`❌ 保存ID文件失败 [${this.filePath}]:`, error.message);
    }
  }

  exists(id) {
    return this.ids.includes(id);
  }

  add(id) {
    if (!this.exists(id)) {
      this.ids.unshift(id);
      
      if (this.ids.length > this.maxSize) {
        this.ids = this.ids.slice(0, this.maxSize);
      }
      
      this.saveSync();
      return true;
    }
    return false;
  }

  addBatch(ids) {
    let addedCount = 0;
    ids.forEach(id => {
      if (!this.exists(id)) {
        this.ids.unshift(id);
        addedCount++;
      }
    });

    if (addedCount > 0) {
      if (this.ids.length > this.maxSize) {
        this.ids = this.ids.slice(0, this.maxSize);
      }
      this.saveSync();
    }
    
    return addedCount;
  }

  cleanup() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveSync();
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

// ========== 发送企业微信消息 ==========
async function sendWeworkMessage(item, webhookUrl) {
  const levelImages = {
    1: "https://img.alicdn.com/imgextra/i2/O1CN01B4pKUX1tIdHA9HOvG_!!6000000005879-2-tps-294-60.png",
    2: "https://img.alicdn.com/imgextra/i3/O1CN01vBjGY61VoBhRLyKX5_!!6000000002699-2-tps-279-60.png",
    3: "https://img.alicdn.com/imgextra/i1/O1CN01xqZ7i21uEnURLYxcU_!!6000000006006-2-tps-279-60.png",
  };

  const levelImage = levelImages[item.rfqStarLevel];
  const contentPreview = item.description.length > 200 
    ? item.description.substring(0, 200) + "..." 
    : item.description;

  const markdownContent = `
##### ${item.subject}
![等级](${levelImage})
**时间:** ${item.openTimeStr}
**数量:** ${item.quantity}
**来源:** ${item.country}
**内容描述:** ${contentPreview}[阅读详情](${item.url})
`.trim();

  try {
    const response = await axios.post(webhookUrl, {
      msgtype: "markdown_v2",
      markdown_v2: { content: markdownContent },
    }, {
      timeout: 5000
    });

    if (response.data.errcode === 0) {
      return { success: true };
    } else {
      return { success: false, error: response.data.errmsg };
    }
  } catch (error) {
    return { success: false, error: error.message };
  }
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

    const newItems = [];

    for (let i = 0; i < matches.length; i++) {
      try {
        let objStr = matches[i][1];

        const urlMatch = objStr.match(/url:\s*"([^"]+)"/);
        let url = urlMatch ? urlMatch[1] : "";

        const idMatch = objStr.match(/id:\s*"([^"]+)"/);
        const id = idMatch ? idMatch[1] : "";

        if (!id) {
          console.warn("⚠️ 未找到ID，跳过该条数据");
          continue;
        }

        if (idManager.exists(id)) {
          stats.duplicate++;
          continue;
        }

        let rfqStarLevel = 0;
        const tagsMatch = objStr.match(/tags:\s*(\[[\s\S]*?\])\s*\|\|/);
        
        if (tagsMatch) {
          const tagMatch = tagsMatch[1].match(/\{"tagName":"([^"]+)","type":"rfq_level"/);
          if (tagMatch) {
            const tagName = tagMatch[1];
            const levelMap = {
              'RFQ_MKT_ST_28102': 2,
              'RFQ_MKT_ST_28101': 3,
              'RFQ_MKT_ST_39408': 1,
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
        
        stats.new++;
        newItems.push(item);

      } catch (error) {
        console.error(`❌ 解析数据失败: ${error.message}`);
      }
    }

    // 先批量标记所有新ID为已处理
    const newIds = newItems.map(item => item.id);
    if (newIds.length > 0) {
      idManager.addBatch(newIds);
      console.log(`✓ [${urlConfig.name}] 已标记 ${newIds.length} 个新ID为已处理`);
    }

    // 再逐个发送
    for (const item of newItems) {
      try {
        const result = await sendWeworkMessage(item, urlConfig.webhook);
        
        if (result.success) {
          stats.sent++;
          console.log(`✓ [${urlConfig.name}] 已发送: ${item.subject.substring(0, 30)}...`);
        } else {
          stats.failed++;
          console.error(`❌ [${urlConfig.name}] 发送失败 [${item.id}]: ${result.error}`);
        }
        
        // 发送间隔，避免触发限流
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        stats.failed++;
        console.error(`❌ [${urlConfig.name}] 发送异常 [${item.id}]: ${error.message}`);
      }
    }

  } catch (error) {
    console.error(`❌ 爬取失败 [${urlConfig.name}]: ${error.message}`);
  }

  return stats;
}

// ========== 主函数 ==========
async function scrapeAllURLs(idManagers) {
  const totalStats = { total: 0, duplicate: 0, new: 0, sent: 0, failed: 0 };

  for (let i = 0; i < CONFIG.urls.length; i++) {
    const urlConfig = CONFIG.urls[i];
    const idManager = idManagers[urlConfig.name]; // 使用该类别专属的ID管理器
    
    console.log(`\n🔍 开始爬取: ${urlConfig.name} (使用文件: ${urlConfig.idFile})`);
    
    const stats = await scrapeOneURL(urlConfig, idManager);

    totalStats.total += stats.total;
    totalStats.duplicate += stats.duplicate;
    totalStats.new += stats.new;
    totalStats.sent += stats.sent;
    totalStats.failed += stats.failed;

    console.log(`${urlConfig.name}: 发现 ${stats.new} 条新数据，已发送 ${stats.sent} 条，重复 ${stats.duplicate} 条`);

    if (i < CONFIG.urls.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log(`\n📊 总计: 新数据 ${totalStats.new} 条，成功发送 ${totalStats.sent} 条，失败 ${totalStats.failed} 条，重复 ${totalStats.duplicate} 条`);
  return totalStats;
}

// ========== 循环服务 ==========
async function startService() {
  console.log(`🚀 服务启动 - 每 ${CONFIG.loopInterval / 1000} 秒执行一次\n`);
  console.log(`📁 每个类别独立保存 ${CONFIG.maxStoredIds} 条ID记录\n`);
  
  // 为每个类别创建独立的ID管理器
  const idManagers = {};
  CONFIG.urls.forEach(urlConfig => {
    idManagers[urlConfig.name] = new IDManager(urlConfig.idFile, CONFIG.maxStoredIds);
  });
  
  let runCount = 0;

  // 优雅退出处理
  const cleanup = () => {
    console.log('\n\n⚠️ 接收到退出信号，正在保存所有数据...');
    Object.values(idManagers).forEach(manager => manager.cleanup());
    console.log('✓ 所有数据已保存，程序退出');
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
  
  while (true) {
    try {
      runCount++;
      const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
      console.log(`\n${'='.repeat(60)}`);
      console.log(`[${now}] 第 ${runCount} 次执行开始`);
      console.log(`${'='.repeat(60)}`);
      
      await scrapeAllURLs(idManagers);
      
      console.log(`\n⏳ 等待 ${CONFIG.loopInterval / 1000} 秒后继续...`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.loopInterval));
    } catch (error) {
      console.error(`❌ 执行出错: ${error.message}`);
      console.error(error.stack);
      console.log(`⏳ 等待 ${CONFIG.loopInterval / 1000} 秒后重试...`);
      await new Promise((resolve) => setTimeout(resolve, CONFIG.loopInterval));
    }
  }
}

// ========== 执行 ==========
startService();