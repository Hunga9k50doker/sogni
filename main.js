const fs = require("fs");
const path = require("path");
const axios = require("axios");
const colors = require("colors");
const { HttpsProxyAgent } = require("https-proxy-agent");
const readline = require("readline");
const user_agents = require("./config/userAgents");
const settings = require("./config/config.js");
const { sleep, loadData, getRandomNumber, saveToken, isTokenExpired, saveJson } = require("./utils.js");
const { Worker, isMainThread, parentPort, workerData } = require("worker_threads");
const { checkBaseUrl } = require("./checkAPI");
const { headers } = require("./core/header.js");
const { showBanner } = require("./core/banner.js");
const localStorage = require("./localStorage.json");
const { Wallet, ethers } = require("ethers");
const { sovleCaptcha } = require("./captcha.js");
const { jwtDecode } = require("jwt-decode");

class ClientAPI {
  constructor(itemData, accountIndex, proxy, baseURL, authInfos) {
    this.headers = headers;
    this.baseURL = baseURL;
    this.baseURL_v2 = "";

    this.itemData = itemData;
    this.accountIndex = accountIndex;
    this.proxy = proxy;
    this.proxyIP = null;
    this.session_name = null;
    this.session_user_agents = this.#load_session_data();
    this.token = null;
    this.authInfos = authInfos;
    this.authInfo = null;
    this.localStorage = localStorage;
    // this.wallet = new ethers.Wallet(this.itemData.privateKey);
    // this.w3 = new Web3(new Web3.providers.HttpProvider(settings.RPC_URL, proxy));
  }

  #load_session_data() {
    try {
      const filePath = path.join(process.cwd(), "session_user_agents.json");
      const data = fs.readFileSync(filePath, "utf8");
      return JSON.parse(data);
    } catch (error) {
      if (error.code === "ENOENT") {
        return {};
      } else {
        throw error;
      }
    }
  }

  #get_random_user_agent() {
    const randomIndex = Math.floor(Math.random() * user_agents.length);
    return user_agents[randomIndex];
  }

  #get_user_agent() {
    if (this.session_user_agents[this.session_name]) {
      return this.session_user_agents[this.session_name];
    }

    console.log(`[Tài khoản ${this.accountIndex + 1}] Tạo user agent...`.blue);
    const newUserAgent = this.#get_random_user_agent();
    this.session_user_agents[this.session_name] = newUserAgent;
    this.#save_session_data(this.session_user_agents);
    return newUserAgent;
  }

  #save_session_data(session_user_agents) {
    const filePath = path.join(process.cwd(), "session_user_agents.json");
    fs.writeFileSync(filePath, JSON.stringify(session_user_agents, null, 2));
  }

  #get_platform(userAgent) {
    const platformPatterns = [
      { pattern: /iPhone/i, platform: "ios" },
      { pattern: /Android/i, platform: "android" },
      { pattern: /iPad/i, platform: "ios" },
    ];

    for (const { pattern, platform } of platformPatterns) {
      if (pattern.test(userAgent)) {
        return platform;
      }
    }

    return "Unknown";
  }

  #set_headers() {
    const platform = this.#get_platform(this.#get_user_agent());
    this.headers["sec-ch-ua"] = `Not)A;Brand";v="99", "${platform} WebView";v="127", "Chromium";v="127`;
    this.headers["sec-ch-ua-platform"] = platform;
    this.headers["User-Agent"] = this.#get_user_agent();
  }

  createUserAgent() {
    try {
      this.session_name = this.itemData.address;
      this.#get_user_agent();
    } catch (error) {
      this.log(`Can't create user agent: ${error.message}`, "error");
      return;
    }
  }

  async log(msg, type = "info") {
    const accountPrefix = `[Account ${this.accountIndex + 1}][${this.itemData.address}]`;
    let ipPrefix = "[Local IP]";
    if (settings.USE_PROXY) {
      ipPrefix = this.proxyIP ? `[${this.proxyIP}]` : "[Unknown IP]";
    }
    let logMessage = "";

    switch (type) {
      case "success":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.green;
        break;
      case "error":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.red;
        break;
      case "warning":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.yellow;
        break;
      case "custom":
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.magenta;
        break;
      default:
        logMessage = `${accountPrefix}${ipPrefix} ${msg}`.blue;
    }
    console.log(logMessage);
  }

  async checkProxyIP() {
    try {
      const proxyAgent = new HttpsProxyAgent(this.proxy);
      const response = await axios.get("https://api.ipify.org?format=json", { httpsAgent: proxyAgent });
      if (response.status === 200) {
        this.proxyIP = response.data.ip;
        return response.data.ip;
      } else {
        throw new Error(`Cannot check proxy IP. Status code: ${response.status}`);
      }
    } catch (error) {
      throw new Error(`Error checking proxy IP: ${error.message}`);
    }
  }

  async makeRequest(
    url,
    method,
    data = {},
    options = {
      retries: 1,
      isAuth: false,
    }
  ) {
    const { retries, isAuth } = options;

    const headers = {
      ...this.headers,
    };

    if (!isAuth) {
      headers["authorization"] = `${this.token}`;
    }

    let proxyAgent = null;
    if (settings.USE_PROXY) {
      proxyAgent = new HttpsProxyAgent(this.proxy);
    }
    let currRetries = 0;
    do {
      try {
        const response = await axios({
          method,
          url: `${url}`,
          headers,
          timeout: 30000,
          ...(proxyAgent ? { httpsAgent: proxyAgent } : {}),
          ...(method.toLowerCase() != "get" ? { data: JSON.stringify(data || {}) } : {}),
        });
        if (response?.data?.data) return { status: response.status, success: true, data: response.data.data };
        return { success: true, data: response.data, status: response.status };
      } catch (error) {
        this.log(`Request failed: ${url} | ${error.message}...`, "warning");

        if (error.message.includes("stream has been aborted")) {
          return { success: false, status: error.status, data: null, error: error.response.data.error || error.response.data.message || error.message };
        }
        if (error.status == 401) {
          this.log(`Error 401: ${JSON.stringify(error.response.data)}`, "warning");
          let token = null;
          token = await this.getValidToken(false, true);
          if (!token) {
            process.exit(1);
          }
          this.token = token;
          return this.makeRequest(url, method, data, options);
        }
        if (error.status == 400) {
          this.log(`Invalid request for ${url}, maybe have new update from server | contact: https://t.me/airdrophuntersieutoc to get new update!`, "error");
          return { success: false, status: error.status, error: error.response.data.error || error.response.data.message || error.message };
        }
        if (error.status == 429) {
          this.log(`Rate limit ${error.message}, waiting 30s to retries`, "warning");
          await sleep(60);
        }
        await sleep(settings.DELAY_BETWEEN_REQUESTS);
      }
      currRetries++;
    } while (currRetries <= retries);
    return { status: error.status, success: false, error: error.message };
  }

  async auth() {
    return null;
    // const wallet = this.wallet;
    // const nonceRes = await this.getNonce();
    // if (!nonceRes.success) return { status: 500, success: false, error: "Can't get nonce" };

    // const signedMessage = await wallet.signMessage(nonceRes.nonce);
    const payload = { signature: "signedMessage", walletAddress: this.itemData.address };
    return this.makeRequest(`${this.baseURL}/v1/account/login`, "post", payload, { isAuth: true });
  }

  async getNonce() {
    return this.makeRequest(
      `${this.baseURL}/v1/account/nonce`,
      "post",
      {
        walletAddress: this.itemData.address,
      },
      { isAuth: true }
    );
  }

  async refreshToken() {
    return this.makeRequest(
      `${this.baseURL}/v1/account/refresh-token`,
      "post",
      {
        refreshToken: this.authInfo.refreshToken || this.itemData.refreshToken,
      },
      { isAuth: true }
    );
  }

  async validateUser(username) {
    return this.makeRequest(`${this.baseURL}/v1/account/create`, "post", { username }, { isAuth: true });
  }
  async register() {
    const nonceRes = await this.getNonce();
    if (!nonceRes.success) return { status: 500, success: false, error: "Can't get nonce" };
    const payload = {
      appid: "998e8a7f-e2e3-490f-9a0a-9e10684ac601",
      username: "xxx",
      email: "xxx@gmail.com",
      subscribe: 1,
      walletAddress: this.itemData.address,
      turnstileToken:
        "0.jtwpZTc-NKB3owbXhLV7tp4b-miBeLl8WgLybSOUHF5h6DIz1S2q1z4aFeGWBS3hrCXJiuRQDPb5AqZWpSGBH5X9DFAkB7nBpMS2jAccFHurox4JQcKRqwy2yRzktsrIGflVfRAWH2TFJZ1D32RXXUlgF-N_0p-dBeMSb9WTRzn8Hhr3uT-waXGKYfPEcmQXBl2Y7fT0kpqI450dTBz3fWszn9M_TDy8JgVUpahTeeNC-nih6eRzXmYTUZb6BNli5fgUJUMFwx-PVzpvF5gkynQ9aMqaEss0MA4VZV3wR_7ClIqOSkP53_NIbkN2OLfhJ7DsXF4H0DnlpwMsKWlu78Qb_sqldl6-C_m0-046xl2b5cil3iChUCJARxo1JRABowme18QNst9YQLNjfPZ1etPkG-ybR7WOlQJvJnCt1fkhi_9vGWAiHMcjfOxfJIBGAt8uw3COc7kHucZS3dxpsrbAaPBsts7HL2MtqltPwwF_VWV9fLk8zoSBdR_ch1Be9G7N09AkJZXzQtAPA-CllVaN4ghzXCsObHhgHqwloEZxg3YNy9Ewgk-kg0DzaVzRy81JKeXI1XA36cSlfEmVbtb4DhBaw0En5t8hejg3pNlBu9Kr8u3FXDEGuNZ1mySamOg_kCJvkwdZCRqbb0JqbY5_GkBXC92CLvy_BtldwYKjXS7yGw17CP0C31UPuyRF8NDHfsPCtQgZRbQMxgOYt1dGhAfTuIpdJVADxzUH1VahvOuR5-Rg2i0NbSTeTCar9ltbaf11JjLdO8FgOibnPYmYwxq8fzDlsO9q3LaXjsPSPbQyWR35L24kjpNu1aQ8EI3Kslk21sNFso8Ke8zJkaunH-N41FY9E-OoywkU9xw.EFMFcGveVTkIJXfX_s_1iA.341c3c3f48947c3fd0499643b83b442c8ba8e3c28ea663e2b145937164a669f3",
      referralCode: settings.REF_CODE,
      signature: "",
    };
    return this.makeRequest(`${this.baseURL}/v1/account/create`, "post", payload, { isAuth: true });
  }

  async getUserData() {
    return this.makeRequest(`${this.baseURL}/profile`, "get");
  }

  async getRewards() {
    return this.makeRequest(`${this.baseURL}/v2/account/rewards`, "get");
  }

  async getLeaderBoard() {
    return this.makeRequest(`${this.baseURL}/v1/leaderboard/?type=renderTokenCompleteArtist&period=lifetime&address=${this.itemData.address}`, "get");
  }

  async claimReward(payload) {
    return this.makeRequest(`${this.baseURL}/v2/account/rewards/claim`, "post", payload);
  }

  async getTransactions() {
    return this.makeRequest(`${this.baseURL}/v1/transactions/list?status=completed&address=${(this, this.itemData.address)}&limit=50`, "get");
  }

  async getBalance() {
    return this.makeRequest(`${this.baseURL}/v1/wallet/balance?walletAddress=${this.itemData.address}`, "get");
  }

  async getModels() {
    return this.makeRequest(`https://socket.sogni.ai/api/v1/models/list`, "get");
  }

  async genarateAI() {
    return this.makeRequest(`${this.baseURL}/v1/projects/EBF03688-58F4-4084-A507-04EC1F86487F`, "get");
  }

  async getValidToken(isNew = false, isRefresh = false) {
    const existingToken = this.token;
    const freshToken = this.authInfo.refreshToken || this.itemData.refreshToken;
    const { isExpired: isExp, expirationDate } = isTokenExpired(existingToken);
    const { isExpired: isExpRe, expirationDate: expirationDateRe } = isTokenExpired(freshToken);

    if (!isRefresh) {
      this.log(`Access token status: ${isExp ? "Expired".yellow : "Valid".green} | Acess token exp: ${expirationDate}`);
      if (existingToken && !isNew && !isExp) {
        this.log("Using valid token", "success");
        return existingToken;
      }
    }

    this.log(`Refresh token status: ${isExpRe ? "Expired".yellow : "Valid".green} | Refresh token exp: ${expirationDateRe}`);
    if ((freshToken && !isNew && !isExpRe) || isRefresh) {
      const newAccessToken = await this.handleRefreshToken();
      if (newAccessToken) return newAccessToken;
    }

    // this.log("No found token or experied, trying get new token...", "warning");
    // const loginRes = await this.auth();
    // if (!loginRes.success) return null;
    // const newToken = loginRes.data;
    // if (newToken.success && newToken.data?.token) {
    //   saveJson(this.session_name, JSON.stringify(newToken.data), "tokens.json");
    //   return newToken.data.token;
    // }
    // this.log("Can't get new token...", "warning");
    return null;
  }

  async handleRefreshToken() {
    this.log("Trying to refresh token...");
    const refreshTokenRes = await this.refreshToken();
    if (!refreshTokenRes.success) return null;
    const { refreshToken, token } = refreshTokenRes.data;
    const newData = {
      ...this.authInfo,
      token,
      refreshToken,
    };

    this.authInfo = newData;
    saveJson(this.session_name, JSON.stringify(newData), "tokens.json");
    return token;
  }
  async handleSyncData() {
    let userData = { success: true, data: null, status: 0 },
      retries = 0;
    let transactionsData = await this.getTransactions();

    do {
      userData = await this.getLeaderBoard();
      if (userData?.success) break;
      retries++;
    } while (retries < 1 && userData.status !== 400);
    const balanceData = await this.getBalance();
    const transactions = transactionsData.data.transactions || [];

    const totalAmount = transactions.reduce((sum, item) => {
      const amount = parseFloat(item.amount);
      return !isNaN(amount) ? sum + amount : sum;
    }, 0);

    if (userData.success && balanceData.success) {
      const { token } = balanceData.data;
      const { username, value, rank } = userData.data[0];
      this.log(
        `Name: ${username || "Unknow"} | Acount balance (tSOGNI): ${totalAmount ? (totalAmount - token).toFixed(4) : "Updating"} | Wallet balance: ${token || 0} tSOGNI | Rank: ${rank || null}`,
        "custom"
      );
    } else {
      return this.log("Can't sync new data...skipping", "warning");
    }
    return userData;
  }

  async handleTask() {
    const newToken = await this.handleRefreshToken();
    if (!newToken) return;
    this.token = newToken;
    const result = await this.getRewards();
    if (!result.success) return;
    const tasks = result.data.rewards.filter((t) => t.canClaim > 0 && t.claimResetFrequencySec <= 0);
    const dailyBoost = result.data.rewards.find((r) => r.id === "2");
    if (dailyBoost?.lastClaimTimestamp && dailyBoost.claimResetFrequencySec) {
      const nextAvailable = (dailyBoost.lastClaimTimestamp + dailyBoost.claimResetFrequencySec) * 1000;
      const timeLeft = nextAvailable - Date.now();
      if (timeLeft > 0) {
        const hours = Math.floor(timeLeft / (3600 * 1000));
        const minutes = Math.floor((timeLeft % (3600 * 1000)) / (60 * 1000));
        this.log(`[${new Date().toISOString()}] Next check in ${hours}h ${minutes}m`, "warning");
      }
    }
    if (tasks.length == 0) return this.log(`No tasks available!`, "warning");
    for (const task of tasks) {
      await sleep(1);

      const resClaim = await this.claimReward({
        claims: [task.id],
      });
      if (!resClaim.success) return this.log(`Can't claim task ${task.id} | ${task.title} | ${JSON.stringify(resClaim)}`, "warning");
      this.log(`Claim task ${task.id} | ${task.title} success | Reward: ${task.amount}`, "success");
    }
  }

  async runAccount() {
    const accountIndex = this.accountIndex;
    this.session_name = this.itemData.address;
    this.authInfo = JSON.parse(this.authInfos[this.session_name] || "{}");
    this.token = this.authInfo?.token;
    this.#set_headers();
    if (settings.USE_PROXY) {
      try {
        this.proxyIP = await this.checkProxyIP();
      } catch (error) {
        this.log(`Cannot check proxy IP: ${error.message}`, "warning");
        return;
      }
      const timesleep = getRandomNumber(settings.DELAY_START_BOT[0], settings.DELAY_START_BOT[1]);
      console.log(`=========Tài khoản ${accountIndex + 1} | ${this.proxyIP} | Bắt đầu sau ${timesleep} giây...`.green);
      await sleep(timesleep);
    }

    const token = await this.getValidToken();
    if (!token) return;
    this.token = token;
    const userData = await this.handleSyncData();
    if (userData.success) {
      await this.handleTask();
      await sleep(1);
      // await this.handleSyncData();
    } else {
      return this.log("Can't get use info...skipping", "error");
    }
  }
}

async function runWorker(workerData) {
  const { itemData, accountIndex, proxy, hasIDAPI, authInfos } = workerData;
  const to = new ClientAPI(itemData, accountIndex, proxy, hasIDAPI, authInfos);
  try {
    await Promise.race([to.runAccount(), new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 24 * 60 * 60 * 1000))]);
    parentPort.postMessage({
      accountIndex,
    });
  } catch (error) {
    parentPort.postMessage({ accountIndex, error: error.message });
  } finally {
    if (!isMainThread) {
      parentPort.postMessage("taskComplete");
    }
  }
}

async function updateRefreshTokenLocal() {
  try {
    let refres = [];
    const tokens = require("./tokens.json");

    for (const session of Object.values(tokens)) {
      const item = JSON.parse(session);
      if (item?.refreshToken) refres.push(item.refreshToken);
    }
    fs.writeFileSync("data.txt", refres.join("\n"));
  } catch (error) {
    console.error("Error updating refresh tokens:", error);
  }
}

async function main() {
  showBanner();
  // await updateRefreshTokenLocal();
  // await sleep(1);
  const privateKeys = loadData("data.txt");
  const proxies = loadData("proxy.txt");
  let authInfos = require("./tokens.json");

  if (privateKeys.length == 0 || (privateKeys.length > proxies.length && settings.USE_PROXY)) {
    console.log("Số lượng proxy và data phải bằng nhau.".red);
    console.log(`Data: ${privateKeys.length}`);
    console.log(`Proxy: ${proxies.length}`);
    process.exit(1);
  }
  if (!settings.USE_PROXY) {
    console.log(`You are running bot without proxies!!!`.yellow);
  }
  let maxThreads = settings.USE_PROXY ? settings.MAX_THEADS : settings.MAX_THEADS_NO_PROXY;

  const { endpoint, message } = await checkBaseUrl();
  if (!endpoint) return console.log(`Không thể tìm thấy ID API, thử lại sau!`.red);
  console.log(`${message}`.yellow);

  const data = privateKeys.map((val, index) => {
    const payload = jwtDecode(val);
    const item = {
      address: payload.addr,
      refreshToken: val,
    };
    new ClientAPI(item, index, proxies[index], endpoint, {}).createUserAgent();
    return item;
  });
  await sleep(1);
  while (true) {
    authInfos = require("./tokens.json");
    let currentIndex = 0;
    const errors = [];
    while (currentIndex < data.length) {
      const workerPromises = [];
      const batchSize = Math.min(maxThreads, data.length - currentIndex);
      for (let i = 0; i < batchSize; i++) {
        const worker = new Worker(__filename, {
          workerData: {
            hasIDAPI: endpoint,
            itemData: data[currentIndex],
            accountIndex: currentIndex,
            proxy: proxies[currentIndex % proxies.length],
            authInfos: authInfos,
          },
        });

        workerPromises.push(
          new Promise((resolve) => {
            worker.on("message", (message) => {
              if (message === "taskComplete") {
                worker.terminate();
              }
              if (settings.ENABLE_DEBUG) {
                console.log(message);
              }
              resolve();
            });
            worker.on("error", (error) => {
              console.log(`Lỗi worker cho tài khoản ${currentIndex}: ${error.message}`);
              worker.terminate();
              resolve();
            });
            worker.on("exit", (code) => {
              worker.terminate();
              if (code !== 0) {
                errors.push(`Worker cho tài khoản ${currentIndex} thoát với mã: ${code}`);
              }
              resolve();
            });
          })
        );

        currentIndex++;
      }

      await Promise.all(workerPromises);

      if (errors.length > 0) {
        errors.length = 0;
      }

      if (currentIndex < data.length) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    await sleep(3);
    console.log(`Updating new data...`.blue);
    await updateRefreshTokenLocal();
    await sleep(3);
    console.log(`=============${new Date().toLocaleString()} | Hoàn thành tất cả tài khoản | Chờ ${settings.TIME_SLEEP} phút=============`.magenta);
    showBanner();
    await sleep(settings.TIME_SLEEP * 60);
  }
}

if (isMainThread) {
  main().catch((error) => {
    console.log("Lỗi rồi:", error);
    process.exit(1);
  });
} else {
  runWorker(workerData);
}
