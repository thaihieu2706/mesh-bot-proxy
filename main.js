import { coday, estimate, claim, start, info } from './scripts.js';
import { logger } from './logger.js';
import fs from 'fs/promises';
import { banner } from './banner.js';
import { HttpsProxyAgent } from 'https-proxy-agent';

let headers = {
    'Content-Type': 'application/json'
};

async function readTokensAndIds() {
    try {
        const tokenData = await fs.readFile('token.txt', 'utf-8');
        const tokens = tokenData.split('\n').filter(line => line.trim());
        
        const idsData = await fs.readFile('unique_id.txt', 'utf-8');
        const uniqueIds = idsData.split('\n').filter(line => line.trim());
        
        if (tokens.length !== uniqueIds.length) {
            logger("Mismatch between the number of tokens and unique ID lines.", "error");
            return [];
        }

        const accounts = tokens.map((line, index) => {
            const [access_token, refresh_token] = line.split('|').map(token => token.trim());
            const ids = uniqueIds[index].split('|').map(id => id.trim());
            return { access_token, refresh_token, unique_ids: ids };
        });

        return accounts;
    } catch (err) {
        logger("Failed to read token or unique ID file:", "error", err.message);
        return [];
    }
}

async function readProxies() {
    try {
        const proxyData = await fs.readFile('proxy.txt', 'utf-8');
        const proxies = proxyData.split('\n').filter(line => line.trim());
        return proxies;
    } catch (err) {
        logger("Failed to read proxy file:", "error", err.message);
        return [];
    }
}

// Refresh Token Function
async function refreshToken(refresh_token, accountIndex, proxyAgent) {
    logger(`Refreshing access token for Account ${accountIndex + 1}...`, "info");
    const payloadData = { refresh_token };
    const response = await coday("https://api.meshchain.ai/meshmain/auth/refresh-token", 'POST', { ...headers, httpsAgent: proxyAgent }, payloadData);

    if (response && response.access_token) {
        const tokenLines = (await fs.readFile('token.txt', 'utf-8')).split('\n');
        tokenLines[accountIndex] = `${response.access_token}|${response.refresh_token}`;
        await fs.writeFile('token.txt', tokenLines.join('\n'), 'utf-8');
        logger(`Account ${accountIndex + 1} token refreshed successfully`, "success");
        return response.access_token;
    }
    logger(`Account ${accountIndex + 1} failed to refresh token`, "error");
    return null;
}

// Main process for a single account
async function processAccount({ access_token, refresh_token, unique_ids }, accountIndex, proxies, numProxiesPerAccount) {
    let accountHeaders = {
        ...headers,
        Authorization: `Bearer ${access_token}`
    };

    for (const unique_id of unique_ids) {
        for (let j = 0; j < numProxiesPerAccount; j++) { // Sử dụng nhiều proxy theo ý thích
            const proxyUrl = proxies[(accountIndex * numProxiesPerAccount + j) % proxies.length];
            const proxyAgent = new HttpsProxyAgent(proxyUrl);
            accountHeaders.httpsAgent = proxyAgent;

            logger(`Account ${accountIndex + 1} | ${unique_id}: Using proxy ${proxyUrl}`, "info");

            const profile = await info(unique_id, accountHeaders);

            if (profile.error) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Profile fetch failed, attempting to refresh token...`, "error");
                const newAccessToken = await refreshToken(refresh_token, accountIndex, proxyAgent);
                if (!newAccessToken) return;
                accountHeaders.Authorization = `Bearer ${newAccessToken}`;
            } else {
                const { name, total_reward } = profile;
                logger(`Account ${accountIndex + 1} | ${unique_id}: ${name} | Balance: ${total_reward}`, "success");
            }

            const filled = await estimate(unique_id, accountHeaders);
            if (!filled) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to fetch estimate.`, "error");
                continue;
            }

            if (filled.value > 10) {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Attempting to claim reward...`);
                const reward = await claim(unique_id, accountHeaders);
                if (reward) {
                    logger(`Account ${accountIndex + 1} | ${unique_id}: Claim successful! New Balance: ${reward}`, "success");
                    await start(unique_id, accountHeaders);
                    logger(`Account ${accountIndex + 1} | ${unique_id}: Started mining again.`, "info");
                } else {
                    logger(`Account ${accountIndex + 1} | ${unique_id}: Failed to claim reward.`, "error");
                }
            } else {
                logger(`Account ${accountIndex + 1} | ${unique_id}: Mine already started. Mine value: ${filled.value}`, "info");
            }
        }
    }
}

// Main function to process all accounts
async function main() {
    logger(banner, "debug");

    const proxies = await readProxies();
    if (proxies.length === 0) {
        logger("No proxies available.", "error");
        return;
    }

    const numProxiesPerAccount = 5; // Số lượng proxy sử dụng cho mỗi tài khoản, có thể thay đổi tùy ý

    while (true) {
        const accounts = await readTokensAndIds();
        if (accounts.length === 0) {
            logger("No accounts to process.", "error");
            return;
        }

        for (let i = 0; i < accounts.length; i++) {
            const account = accounts[i];
            logger(`Processing Account ${i + 1} using proxies...`, "info");
            await processAccount(account, i, proxies, numProxiesPerAccount);
        }

        await new Promise(resolve => setTimeout(resolve, 60000)); // Runs every 60 seconds
    }
}

// Run Main
main();

