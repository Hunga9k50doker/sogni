require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { Wallet, ethers } = require("ethers");
const { HttpsProxyAgent } = require("https-proxy-agent");
const { SocksProxyAgent } = require("socks-proxy-agent");
const { loadData, saveJson, getRandomElement, getRandomNumber, sleep } = require("./utils.js");
const colors = require("colors");
const settings = require("./config/config.js");

function generateWallet() {
  const wallet = Wallet.createRandom();
  return wallet;
}

function createSiweMessage(address) {
  const nonce = ethers.hexlify(ethers.randomBytes(32)).slice(2);
  const timestamp = new Date().toISOString();
  return `klokapp.ai wants you to sign in with your Ethereum account:\n${address}\n\n\nURI: https://klokapp.ai/\nVersion: 1\nChain ID: 1\nNonce: ${nonce}\nIssued At: ${timestamp}`;
}

async function signMessageAndRegister(wallet, agent) {
  const address = wallet.address;
  const message = createSiweMessage(address);
  console.log(`📝 Signing Message for ${address}`);
  const signedMessage = await wallet.signMessage(message);
  const payload = { signedMessage, message, referral_code: settings.REF_CODE };

  try {
    const response = await axios.post(`${settings.BASE_URL}/verify`, payload, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0",
        Origin: "https://klokapp.ai",
        Referer: "https://klokapp.ai/",
      },
      httpAgent: agent, // Use the agent for the request
    });
    if (response.data.message == "Verification successful") {
      console.log(`✅ Sign ${address} success! Wallet info saved walllets txt | Private key saved privateKeys.txt`.green);
      const data = `\n
    Address: ${address}
    Private key: ${wallet.privateKey}
    Seed phare: ${wallet.mnemonic.phrase || JSON.stringify(wallet.mnemonic)}
    ==============================`;
      fs.appendFileSync("wallets.txt", data, "utf8");
      fs.appendFileSync("privateKeys.txt", `\n${wallet.privateKey}`, "utf8");
      const token = response.data.session_token;
      saveJson(address, token, "tokens.json");
      return token;
    } else {
      console.log(`Register ${address} failed!`.yellow, JSON.stringify(response.data));
    }
  } catch (error) {
    console.error(`❌ Failed sign ${address}:`, error.response ? JSON.stringify(error.response.data || {}) : error.message);
  }
}

function getProxyAgent(proxy) {
  if (proxy.startsWith("socks://")) {
    return new SocksProxyAgent(proxy);
  } else if (proxy.startsWith("http://")) {
    return new HttpsProxyAgent(proxy);
  }
  return null;
}

async function checkProxyIP(proxy) {
  try {
    const proxyAgent = new HttpsProxyAgent(proxy);
    const response = await axios.get("https://api.ipify.org?format=json", {
      httpsAgent: proxyAgent,
      timeout: 10000,
    });

    if (response.status === 200) {
      return response.data.ip;
    } else {
      throw new Error(`Không thể kiểm tra IP của proxy. Status code: ${response.status}`);
    }
  } catch (error) {
    throw new Error(`Error khi kiểm tra IP của proxy: ${error.message}`);
  }
}

async function main() {
  console.log(colors.yellow("Tool được phát triển bởi nhóm tele Airdrop Hunter Siêu Tốc (https://t.me/airdrophuntersieutoc)"));
  console.log(colors.magenta(`\nNumber ref buff: ${settings.AMOUNT_REF} | Ref code: ${settings.REF_CODE}`));

  if (!settings.REF_CODE) {
    console.error("❌ Not found referral code!");
    process.exit(1);
  }

  const proxies = loadData("proxy.txt");
  let ip = "Unknown";
  for (let i = 0; i < settings.AMOUNT_REF; i++) {
    try {
      ip = await checkProxyIP(proxies[i]);
    } catch (error) {
      console.log(`can't check proxy ${proxies[i]}: ${error.message}`.red);
      continue;
    }
    const agent = getProxyAgent(proxies[i]); // Get a random proxy agent first
    const wallet = generateWallet();
    console.log(`\n[${i + 1}/${settings.AMOUNT_REF}]Start wallet ${wallet.address} | IP: ${ip}`.blue);
    await signMessageAndRegister(wallet, agent); // Use the agent for each request
  }
}

main();
