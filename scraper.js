const axios = require("axios");
const cheerio = require("cheerio");
const sqlite3 = require("sqlite3").verbose();
const fs = require("fs");
const path = require("path");

// ========== 确保数据目录存在 ==========
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
  console.log('✓ 已创建 data 目录');
}

// ========== 配置 ==========
const CONFIG = {
  dbPath: path.join(__dirname, "data", "crawler.db"), // ✅ 数据库在 data 目录
  loopInterval: 30000,
  urls: [
    // {
    //   name: "纸袋",
    //   tableName: "paper_bag", // 独立的表名
    //   url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.14.68ff65aaNkrl5H&categoryIds=201271492&recently=Y",
    //   webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=691cd204-4530-4cec-a5f2-c20d53c7b500",
    // },
    {
      name: "标签",
      tableName: "label", // 独立的表名
      url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.4ad465aaP5FXb9&categoryIds=201726904&recently=Y",
      webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=63d28aab-5e65-4273-ab0d-398cf430790b",
    },
    // {
    //   name: "卡片",
    //   tableName: "card", // 独立的表名
    //   url: "https://sourcing.alibaba.com/rfq/rfq_search_list.htm?spm=a2700.8073608.1998677539.13.6b0e65aaFBblYX&categoryIds=100002844&recently=Y",
    //   webhook: "https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=4aa70d53-ac0f-49cc-b410-43af270fc07e",
    // },
  ],
};

// ========== SQLite ID 管理类 ==========
class SQLiteIDManager {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
    this.initPromise = this.init();
  }

  /**
   * 初始化数据库连接和表结构
   */
  async init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          console.error("❌ 数据库连接失败:", err.message);
          reject(err);
        } else {
          console.log(`✓ 数据库已连接: ${this.dbPath}`);
          resolve();
        }
      });
    });
  }

  /**
   * 为指定分类创建独立的表
   */
  async createTableForCategory(tableName) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        // 1. 已处理ID表（核心去重表）
        this.db.run(
          `CREATE TABLE IF NOT EXISTS ${tableName}_ids (
            id TEXT PRIMARY KEY,
            first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
          (err) => {
            if (err) {
              console.error(`❌ 创建表 ${tableName}_ids 失败:`, err.message);
              reject(err);
            }
          }
        );

        // 2. 推送日志表
        this.db.run(
          `CREATE TABLE IF NOT EXISTS ${tableName}_logs (
            log_id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_id TEXT NOT NULL,
            subject TEXT,
            url TEXT,
            quantity TEXT,
            country TEXT,
            rfq_level INTEGER,
            status TEXT NOT NULL,
            error_message TEXT,
            pushed_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
          (err) => {
            if (err) {
              console.error(`❌ 创建表 ${tableName}_logs 失败:`, err.message);
              reject(err);
            }
          }
        );

        // 3. 统计表
        this.db.run(
          `CREATE TABLE IF NOT EXISTS ${tableName}_stats (
            stat_id INTEGER PRIMARY KEY AUTOINCREMENT,
            total_fetched INTEGER DEFAULT 0,
            new_items INTEGER DEFAULT 0,
            duplicate_items INTEGER DEFAULT 0,
            push_success INTEGER DEFAULT 0,
            push_failed INTEGER DEFAULT 0,
            crawled_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )`,
          (err) => {
            if (err) {
              console.error(`❌ 创建表 ${tableName}_stats 失败:`, err.message);
              reject(err);
            } else {
              console.log(`✓ 表 ${tableName} 系列已就绪`);
              resolve();
            }
          }
        );

        // 创建索引
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_${tableName}_id ON ${tableName}_ids(id)`);
        this.db.run(`CREATE INDEX IF NOT EXISTS idx_${tableName}_pushed_at ON ${tableName}_logs(pushed_at)`);
      });
    });
  }

  /**
   * 检查ID是否存在
   */
  async exists(tableName, id) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT id FROM ${tableName}_ids WHERE id = ?`,
        [id],
        (err, row) => {
          if (err) reject(err);
          else resolve(!!row);
        }
      );
    });
  }

  /**
   * 批量检查ID是否存在（返回新ID列表）
   */
  async filterNewIds(tableName, ids) {
    await this.initPromise;

    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT id FROM ${tableName}_ids WHERE id IN (${placeholders})`,
        ids,
        (err, rows) => {
          if (err) reject(err);
          else {
            const existingIds = new Set(rows.map((r) => r.id));
            const newIds = ids.filter((id) => !existingIds.has(id));
            resolve(newIds);
          }
        }
      );
    });
  }

  /**
   * 添加单个ID
   */
  async add(tableName, id) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT OR IGNORE INTO ${tableName}_ids (id) VALUES (?)`,
        [id],
        function (err) {
          if (err) reject(err);
          else resolve(this.changes > 0);
        }
      );
    });
  }

  /**
   * 批量添加ID
   */
  async addBatch(tableName, ids) {
    await this.initPromise;

    if (ids.length === 0) return 0;

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run("BEGIN TRANSACTION");

        const stmt = this.db.prepare(
          `INSERT OR IGNORE INTO ${tableName}_ids (id) VALUES (?)`
        );

        let addedCount = 0;
        ids.forEach((id) => {
          stmt.run([id], function (err) {
            if (!err && this.changes > 0) addedCount++;
          });
        });

        stmt.finalize((err) => {
          if (err) {
            this.db.run("ROLLBACK");
            reject(err);
          } else {
            this.db.run("COMMIT", (err) => {
              if (err) reject(err);
              else resolve(addedCount);
            });
          }
        });
      });
    });
  }

  /**
   * 记录推送日志
   */
  async logPush(tableName, item, status, errorMessage = null) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO ${tableName}_logs 
         (item_id, subject, url, quantity, country, rfq_level, status, error_message) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.id,
          item.subject,
          item.url,
          item.quantity,
          item.country,
          item.rfqStarLevel,
          status,
          errorMessage,
        ],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  /**
   * 记录爬取统计
   */
  async logStats(tableName, stats) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.run(
        `INSERT INTO ${tableName}_stats 
         (total_fetched, new_items, duplicate_items, push_success, push_failed) 
         VALUES (?, ?, ?, ?, ?)`,
        [
          stats.total || 0,
          stats.new || 0,
          stats.duplicate || 0,
          stats.sent || 0,
          stats.failed || 0,
        ],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        }
      );
    });
  }

  /**
   * 获取统计信息
   */
  async getStats(tableName) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT 
           COUNT(*) as total_ids,
           MIN(first_seen_at) as first_seen,
           MAX(last_checked_at) as last_checked
         FROM ${tableName}_ids`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  }

  /**
   * 获取今日统计
   */
  async getTodayStats(tableName) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.get(
        `SELECT 
           SUM(total_fetched) as total,
           SUM(new_items) as new_items,
           SUM(push_success) as success,
           SUM(push_failed) as failed
         FROM ${tableName}_stats 
         WHERE DATE(crawled_at) = DATE('now')`,
        [],
        (err, row) => {
          if (err) reject(err);
          else resolve(row || { total: 0, new_items: 0, success: 0, failed: 0 });
        }
      );
    });
  }

  /**
   * 获取最近的推送日志
   */
  async getRecentLogs(tableName, limit = 10) {
    await this.initPromise;

    return new Promise((resolve, reject) => {
      this.db.all(
        `SELECT * FROM ${tableName}_logs ORDER BY pushed_at DESC LIMIT ?`,
        [limit],
        (err, rows) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });
  }

  /**
   * 关闭数据库连接
   */
  async close() {
    if (this.db) {
      return new Promise((resolve, reject) => {
        this.db.close((err) => {
          if (err) reject(err);
          else {
            console.log("✓ 数据库连接已关闭");
            resolve();
          }
        });
      });
    }
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
  const contentPreview =
    item.description.length > 200
      ? item.description.substring(0, 200) + "..."
      : item.description;
  const now = new Date().toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
  const markdownContent = `
##### ${item.subject}
![等级](${levelImage})
**时间:** ${now}
**数量:** ${item.quantity}
**来源:** ${item.country}
**内容描述:** ${contentPreview}[阅读详情](${item.url})
`.trim();

  try {
    const response = await axios.post(
      webhookUrl,
      {
        msgtype: "markdown_v2",
        markdown_v2: { content: markdownContent },
      },
      {
        timeout: 5000,
      }
    );

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
async function scrapeOneURL(urlConfig, dbManager) {
  const stats = { total: 0, duplicate: 0, new: 0, sent: 0, failed: 0 };
  const tableName = urlConfig.tableName;
  const fullCookie = `
ali_apache_id=33.8.180.39.1761265072910.656194.5;
_tb_token_=7835377600e87;
cookie2=1d48e853a04e4d5f55e6d4f88b7ed66;
ali_apache_track=mt=3|mid=ch1558703453h|wmxman_us_f=x_l=1&cna=M7WBIW+5GAYCAXQDEsaFSJZ2;
int_common_former=DQWOdLuP:23ZNUvolco//wpG70ObSuPRzQ5iF1H51Q1SPfey9@NfQg==;
xman_status2=0;
JSESSIONID=139E254AE4F4DA99D253435B2F6968E4
`.replace(/\n/g, '').trim();
  try {
    const response = await axios.get(urlConfig.url, {
      headers: {
        "Cookie": fullCookie,
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      },
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

    const allItems = [];

    // 解析所有数据
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

        let rfqStarLevel = 0;
        const tagsMatch = objStr.match(/tags:\s*(\[[\s\S]*?\])\s*\|\|/);

        if (tagsMatch) {
          const tagMatch = tagsMatch[1].match(
            /\{"tagName":"([^"]+)","type":"rfq_level"/
          );
          if (tagMatch) {
            const tagName = tagMatch[1];
            const levelMap = {
              RFQ_MKT_ST_28102: 2,
              RFQ_MKT_ST_28101: 3,
              RFQ_MKT_ST_39408: 1,
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

        url = url.startsWith("//")
          ? "https:" + url
          : url.startsWith("http")
          ? url
          : "https://" + url;

        const item = {
          id,
          url,
          rfqStarLevel,
          openTimeStr,
          country,
          quantity,
          description,
          subject,
        };

        allItems.push(item);
      } catch (error) {
        console.error(`❌ 解析数据失败: ${error.message}`);
      }
    }

    // 批量过滤出新ID（高性能）
    const allIds = allItems.map((item) => item.id);
    const newIds = await dbManager.filterNewIds(tableName, allIds);

    stats.new = newIds.length;
    stats.duplicate = stats.total - stats.new;

    console.log(`✓ [${urlConfig.name}] 新数据: ${stats.new} 条，重复: ${stats.duplicate} 条`);

    if (newIds.length === 0) {
      await dbManager.logStats(tableName, stats);
      return stats;
    }

    // 获取新数据的完整信息
    const newItems = allItems.filter((item) => newIds.includes(item.id));

    // 逐个发送（发送成功后才标记）
    for (const item of newItems) {
      try {
        const result = await sendWeworkMessage(item, urlConfig.webhook);

        if (result.success) {
          // ✅ 发送成功：标记ID + 记录日志
          await dbManager.add(tableName, item.id);
          await dbManager.logPush(tableName, item, "success");
          stats.sent++;
          console.log(
            `✓ [${urlConfig.name}] 已推送: ${item.subject.substring(0, 30)}...`
          );
        } else {
          // ❌ 发送失败：记录日志但不标记ID（下次继续尝试）
          await dbManager.logPush(tableName, item, "failed", result.error);
          stats.failed++;
          console.error(
            `❌ [${urlConfig.name}] 推送失败 [${item.id}]: ${result.error}`
          );
        }

        // 发送间隔，避免触发限流
        await new Promise((resolve) => setTimeout(resolve, 500));
      } catch (error) {
        stats.failed++;
        console.error(
          `❌ [${urlConfig.name}] 推送异常 [${item.id}]: ${error.message}`
        );

        // 记录推送失败日志
        await dbManager.logPush(tableName, item, "error", error.message);
      }
    }

    // 记录本次爬取统计
    await dbManager.logStats(tableName, stats);

  } catch (error) {
    console.error(`❌ 爬取失败 [${urlConfig.name}]: ${error.message}`);
  }

  return stats;
}

// ========== 主函数 ==========
async function scrapeAllURLs(dbManager) {
  const totalStats = { total: 0, duplicate: 0, new: 0, sent: 0, failed: 0 };

  for (let i = 0; i < CONFIG.urls.length; i++) {
    const urlConfig = CONFIG.urls[i];

    console.log(
      `\n🔍 开始爬取: ${urlConfig.name} (使用表: ${urlConfig.tableName})`
    );

    const stats = await scrapeOneURL(urlConfig, dbManager);

    totalStats.total += stats.total;
    totalStats.duplicate += stats.duplicate;
    totalStats.new += stats.new;
    totalStats.sent += stats.sent;
    totalStats.failed += stats.failed;

    console.log(
      `${urlConfig.name}: 发现 ${stats.new} 条新数据，已发送 ${stats.sent} 条，重复 ${stats.duplicate} 条`
    );

    if (i < CONFIG.urls.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }

  console.log(
    `\n📊 总计: 新数据 ${totalStats.new} 条，成功发送 ${totalStats.sent} 条，失败 ${totalStats.failed} 条，重复 ${totalStats.duplicate} 条`
  );
  return totalStats;
}

// ========== 循环服务 ==========
async function startService() {
  console.log(`🚀 服务启动 - 每 ${CONFIG.loopInterval / 1000} 秒执行一次\n`);
  console.log(`📁 使用 SQLite 数据库: ${CONFIG.dbPath}`);
  console.log(`📁 每个分类独立表，永久保存所有ID\n`);

  // 初始化数据库管理器
  const dbManager = new SQLiteIDManager(CONFIG.dbPath);

  // 为每个类别创建独立的表
  for (const urlConfig of CONFIG.urls) {
    await dbManager.createTableForCategory(urlConfig.tableName);
  }

  let runCount = 0;

  // 优雅退出处理
  const cleanup = async () => {
    console.log("\n\n⚠️ 接收到退出信号，正在关闭数据库连接...");
    await dbManager.close();
    console.log("✓ 数据库已关闭，程序退出");
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  while (true) {
    try {
      runCount++;
      const now = new Date().toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
      });
      console.log(`\n${"=".repeat(60)}`);
      console.log(`[${now}] 第 ${runCount} 次执行开始`);
      console.log(`${"=".repeat(60)}`);

      await scrapeAllURLs(dbManager);

      // 显示今日统计
      console.log("\n📅 今日各类别统计:");
      for (const urlConfig of CONFIG.urls) {
        const todayStats = await dbManager.getTodayStats(urlConfig.tableName);
        const totalStats = await dbManager.getStats(urlConfig.tableName);
        console.log(
          `  ${urlConfig.name}: 累计ID ${totalStats.total_ids} | 今日爬取 ${todayStats.total || 0} | 新增 ${
            todayStats.new_items || 0
          } | 成功 ${todayStats.success || 0} | 失败 ${todayStats.failed || 0}`
        );
      }

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