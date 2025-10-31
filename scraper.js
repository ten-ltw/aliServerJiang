const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');

// ========== 配置 ==========
const CONFIG = {
  maxStoredIds: 60,           // 最多存储60个ID
  idStorageFile: 'processed_ids.json',  // ID存储文件
  // targetTimeFilter: '1 hours before',   // 只处理1小时内的数据
  
  // ========== 多个URL配置 ==========
  urls: [
    {
      name: 'Category 包装标签',
      url: 'https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.14.68ff65aaNkrl5H&categoryIds=201271492&recently=Y'
    },
    {
      name: 'Category 纸及纸板印刷',  // 替换成你的第二个URL名称
      url: 'https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.4ad465aaP5FXb9&categoryIds=201726904&recently=Y'
    },
    {
      name: 'Category 纸袋',  // 替换成你的第三个URL名称
      url: 'https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.6b0e65aaFBblYX&categoryIds=100002844&recently=Y'
    }
  ]
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
        const data = fs.readFileSync(this.filePath, 'utf-8');
        return JSON.parse(data);
      }
    } catch (error) {
      console.error('⚠️  读取ID文件失败:', error.message);
    }
    return [];
  }

  save() {
    try {
      fs.writeFileSync(
        this.filePath,
        JSON.stringify(this.ids, null, 2),
        'utf-8'
      );
    } catch (error) {
      console.error('⚠️  保存ID文件失败:', error.message);
    }
  }

  exists(id) {
    return this.ids.includes(id);
  }

  add(id) {
    if (!this.exists(id)) {
      this.ids.unshift(id);
      
      if (this.ids.length > this.maxSize) {
        const removed = this.ids.pop();
        console.log(`   🗑️  删除最旧的ID: ${removed}`);
      }
      
      this.save();
      return true;
    }
    return false;
  }

  getStats() {
    return {
      total: this.ids.length,
      capacity: this.maxSize,
      usage: `${this.ids.length}/${this.maxSize}`
    };
  }
}

// ========== 模拟发送给客户的函数 ==========
async function sendToClient(item, sourceName) {
  console.log(`   📤 发送给客户:`);
  console.log(`      来源: ${sourceName}`);
  console.log(`      ID: ${item.id}`);
  console.log(`      URL: https:${item.url}`);
  console.log(`      星级: ${'⭐'.repeat(item.rfqStarLevel)}`);
  console.log(`      时间: ${item.openTimeStr}`);
  var result = await fetchDetailHTML(item.url,item.id);
  result.rfqStarLevel = item.rfqStarLevel;
  // 这里替换成你实际的发送逻辑
  // 例如：发送邮件、调用API、发送消息等
  
  await new Promise(resolve => setTimeout(resolve, 100));
  
  return true;
}

async function fetchDetailHTML(url, itemId) {
  try {
    // 拼接完整URL
    let fullUrl = url;
    if (url.startsWith('//')) {
      fullUrl = 'https:' + url;
    } else if (!url.startsWith('http')) {
      fullUrl = 'https://' + url;
    }
    
    console.log(`      🌐 请求详情页: ${fullUrl}`);
    
    const response = await axios.get(fullUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    // ========== 查找目标脚本 ==========
    let targetScript = null;
    
    $('script').each((index, element) => {
      const content = $(element).html() || '';
      if (content.includes('PAGE_DATA') && content.includes('userType')) {
        targetScript = content;
        return false;
      }
    });
    
    if (!targetScript) {
      return {
        success: false,
        error: '未找到目标脚本',
        url: fullUrl
      };
    }
    
    console.log(`      ✅ 找到目标脚本`);
    
    // ========== 解码 ==========
    const decodedScript = decodeUnicodeEscapes(targetScript);
    
    // ========== 提取数据 ==========
    const extractResult = extractPageData(decodedScript);
    
    if (extractResult.success) {
      console.log(`      📦 quantity: ${extractResult.data.quantity}`);
      console.log(`      📝 subject: ${extractResult.data.subject}`);
      console.log(`      📄 enDescription 长度: ${extractResult.data.enDescription?.length || 0} 字符\n`);
      
      return {
        success: true,
        url: fullUrl,
        quantity: extractResult.data.quantity,
        subject: extractResult.data.subject,
        enDescription: extractResult.data.enDescription
      };
    } else {
      console.log(`      ⚠️  数据提取失败: ${extractResult.error}\n`);
      return {
        success: false,
        error: extractResult.error,
        url: fullUrl
      };
    }
    
  } catch (error) {
    console.error(`      ❌ 抓取详情页失败: ${error.message}`);
    return {
      success: false,
      error: error.message,
      url: url
    };
  }
}

// ========== 提取函数 ==========
function extractPageData(scriptContent) {
  try {
    // 提取 quantity
    const quantityMatch = scriptContent.match(/quantity:\s*"?(\d+)"?/);
    const quantity = quantityMatch ? parseInt(quantityMatch[1]) : null;
    
    // 提取 subject
    const subjectMatch = scriptContent.match(/subject:\s*"([^"]+)"/);
    const subject = subjectMatch ? subjectMatch[1] : null;
    
    // 提取 enDescription
    const enDescMatch = scriptContent.match(/enDescription:\s*"([^"]*)"/);
    let enDescription = enDescMatch ? enDescMatch[1] : null;
    
    // 处理 enDescription 中的转义字符
    if (enDescription) {
      enDescription = enDescription
        .replace(/\\r\\n/g, ' ')     // \r\n 转成空格
        .replace(/\\n/g, ' ')        // \n 转成空格
        .replace(/\\r/g, ' ')        // \r 转成空格
        .replace(/\\t/g, ' ')        // \t 转成空格
        .replace(/\\"/g, '"')        // \" 转成引号
        .replace(/\\'/g, "'")        // \' 转成单引号
        .replace(/\\\\/g, '\\')      // \\ 转成反斜杠
        .replace(/\s+/g, ' ')        // 合并多个空格
        .trim();                     // 去掉首尾空格
    }
    
    return {
      success: true,
      data: {
        quantity,
        subject,
        enDescription
      }
    };
    
  } catch (error) {
    return {
      success: false,
      error: error.message
    };
  }
}

// ========== 单个URL爬取函数 ==========
async function scrapeOneURL(urlConfig, idManager) {
  const stats = {
    total: 0,
    filtered: 0,
    duplicate: 0,
    new: 0,
    sent: 0,
    failed: 0
  };

  try {
    console.log(`\n${'─'.repeat(80)}`);
    console.log(`🎯 正在爬取: ${urlConfig.name}`);
    console.log(`   URL: ${urlConfig.url}`);
    console.log(`${'─'.repeat(80)}\n`);
    
    const response = await axios.get(urlConfig.url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
      timeout: 10000
    });

    const $ = cheerio.load(response.data);
    
    // ========== 查找目标脚本 ==========
    let targetScript = null;
    
    $('script').each((index, element) => {
      const content = $(element).html() || '';
      if (content.includes('PAGE_DATA') && content.includes('uuid')) {
        targetScript = content;
        return false;
      }
    });
    
    if (!targetScript) {
      console.log('   ❌ 未找到目标脚本\n');
      return stats;
    }
    
    console.log(`   ✅ 找到目标脚本\n`);
    
    // ========== 解码 ==========
    const decodedScript = decodeUnicodeEscapes(targetScript);
    
    // ========== 提取数据 ==========
    const pushRegex = /window\.PAGE_DATA\["index"\]\.data\.push\((\{[\s\S]*?\})\);/g;
    const matches = [...decodedScript.matchAll(pushRegex)];
    
    stats.total = matches.length;
    console.log(`   📦 找到 ${matches.length} 条数据\n`);
    
    if (matches.length === 0) {
      return stats;
    }
    
    // ========== 处理每条数据 ==========
    for (let i = 0; i < matches.length; i++) {
      try {
        let objStr = matches[i][1];
        
        const urlMatch = objStr.match(/url:\s*"([^"]+)"/);
        const url = urlMatch ? urlMatch[1] : '';
        
        const idMatch = objStr.match(/id:\s*"([^"]+)"/);
        const id = idMatch ? idMatch[1] : '';
        
        const starLevelMatch = objStr.match(/rfqStarLevel:\s*parseInt\("(\d+)"/);
        const rfqStarLevel = starLevelMatch ? parseInt(starLevelMatch[1]) : 0;
        
        const openTimeMatch = objStr.match(/openTimeStr:\s*"([^"]+)"/);
        const openTimeStr = openTimeMatch ? openTimeMatch[1] : '';
        
        // // 时间过滤
        // if (openTimeStr !== CONFIG.targetTimeFilter) {
        //   console.log(`   ⏱️  遇到 "${openTimeStr}"，停止处理\n`);
        //   stats.filtered = matches.length - i;
        //   break;
        // }
        
        const item = { id, url, rfqStarLevel, openTimeStr };
        
        // ID去重
        if (idManager.exists(id)) {
          stats.duplicate++;
          console.log(`   ⏭️  跳过重复: ${id}`);
          continue;
        }
        
        // 新数据
        stats.new++;
        console.log(`\n   ✨ 新数据 #${stats.new}: ${id}`);
        
        try {
          await sendToClient(item, urlConfig.name);
          stats.sent++;
          idManager.add(id);
          console.log(`   ✅ 已发送并记录\n`);
        } catch (error) {
          stats.failed++;
          console.error(`   ❌ 发送失败: ${error.message}\n`);
        }
        
      } catch (error) {
        console.error(`   ⚠️  解析第 ${i + 1} 条失败: ${error.message}`);
      }
    }
    
  } catch (error) {
    console.error(`   ❌ 爬取失败: ${error.message}\n`);
  }
  
  return stats;
}

// ========== 主函数：轮询所有URL ==========
async function scrapeAllURLs() {
  console.log('\n');
  console.log('═'.repeat(80));
  console.log('🚀 开始多URL轮询爬取');
  console.log('═'.repeat(80));
  
  // 初始化ID管理器
  const idManager = new IDManager(CONFIG.idStorageFile, CONFIG.maxStoredIds);
  console.log(`\n📊 ID存储状态: ${idManager.getStats().usage}`);
  console.log(`🔗 待爬取URL数量: ${CONFIG.urls.length}\n`);
  
  // 汇总统计
  const totalStats = {
    total: 0,
    filtered: 0,
    duplicate: 0,
    new: 0,
    sent: 0,
    failed: 0
  };
  
  const urlResults = [];
  
  // ========== 循环爬取每个URL ==========
  for (let i = 0; i < CONFIG.urls.length; i++) {
    const urlConfig = CONFIG.urls[i];
    
    console.log(`\n[${ i + 1}/${CONFIG.urls.length}] 开始处理...`);
    
    const stats = await scrapeOneURL(urlConfig, idManager);
    
    // 记录结果
    urlResults.push({
      name: urlConfig.name,
      ...stats
    });
    
    // 累加统计
    totalStats.total += stats.total;
    totalStats.filtered += stats.filtered;
    totalStats.duplicate += stats.duplicate;
    totalStats.new += stats.new;
    totalStats.sent += stats.sent;
    totalStats.failed += stats.failed;
    
    // 打印单个URL统计
    console.log(`   📊 本URL统计:`);
    console.log(`      原始: ${stats.total} | 过滤: ${stats.filtered} | 重复: ${stats.duplicate}`);
    console.log(`      新数据: ${stats.new} | 已发送: ${stats.sent} | 失败: ${stats.failed}`);
    
    // 延迟，避免请求过快
    if (i < CONFIG.urls.length - 1) {
      console.log(`\n   ⏳ 等待 2 秒后继续...\n`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }
  
  // ========== 最终汇总报告 ==========
  console.log('\n');
  console.log('═'.repeat(80));
  console.log('📊 最终汇总报告');
  console.log('═'.repeat(80));
  console.log();
  
  console.log('各URL详细统计:');
  urlResults.forEach((result, index) => {
    console.log(`\n  ${index + 1}. ${result.name}`);
    console.log(`     原始数据: ${result.total} 条`);
    console.log(`     时间过滤: ${result.filtered} 条`);
    console.log(`     重复数据: ${result.duplicate} 条`);
    console.log(`     新数据: ${result.new} 条`);
    console.log(`     成功发送: ${result.sent} 条`);
    console.log(`     发送失败: ${result.failed} 条`);
  });
  
  console.log('\n' + '─'.repeat(80));
  console.log('总计:');
  console.log(`  原始数据: ${totalStats.total} 条`);
  console.log(`  时间过滤: ${totalStats.filtered} 条`);
  console.log(`  重复数据: ${totalStats.duplicate} 条`);
  console.log(`  新数据: ${totalStats.new} 条`);
  console.log(`  成功发送: ${totalStats.sent} 条`);
  console.log(`  发送失败: ${totalStats.failed} 条`);
  
  const finalIdStats = idManager.getStats();
  console.log(`\n📁 ID存储状态: ${finalIdStats.usage}`);
  
  console.log('\n✅ 全部完成!');
  console.log('═'.repeat(80));
  console.log();
  
  return {
    urlResults,
    totalStats,
    idStats: finalIdStats
  };
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

// ========== 执行 ==========
scrapeAllURLs();