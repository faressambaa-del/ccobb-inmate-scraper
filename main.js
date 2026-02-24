import { Actor } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';

await Actor.init();

// ── Input ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput();
const {
    name          = '',         // "Last First"  e.g. "Smith John"
    soid          = '',         // optional SOID for faster lookup
    serial        = '',         // optional serial number
    mode          = 'Inquiry',  // "Inquiry" or "In Custody"
    proxyUsername = '',         // WebShare proxy username
    proxyPassword = '',         // WebShare proxy password
    proxyList     = [],         // e.g. ["12.34.56.78:8080", "23.45.67.89:8080"]
} = input || {};

// ── Pick a random proxy from the WebShare list on each run ───────────────────
function getRandomProxy() {
    if (!proxyList || proxyList.length === 0) return null;
    const proxy = proxyList[Math.floor(Math.random() * proxyList.length)];
    return `http://${proxyUsername}:${proxyPassword}@${proxy}`;
}

const selectedProxy = getRandomProxy();

const INQUIRY_URL = [
    'http://inmate-search.cobbsheriff.org/inquiry.asp',
    `?soid=${encodeURIComponent(soid)}`,
    `&inmate_name=${encodeURIComponent(name)}`,
    `&serial=${encodeURIComponent(serial)}`,
    `&qry=${encodeURIComponent(mode)}`,
].join('');

console.log(`Searching  → name="${name}"  soid="${soid}"  mode="${mode}"`);
console.log(`Target URL → ${INQUIRY_URL}`);
console.log(`Proxies available: ${proxyList.length}  |  Selected: ${selectedProxy ? selectedProxy.split('@')[1] : 'none (no proxy)'}`);

// ── Result container ─────────────────────────────────────────────────────────
let result = {
    found         : false,
    name,
    mode,
    scrapedAt     : new Date().toISOString(),
    gotDetailPage : false,
    pageData      : { allRows: [] },
    debugInfo     : {},
};

// ── Crawler ──────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({

    launchContext: {
        launchOptions: {
            headless : true,
            args     : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                // Route all browser traffic through the selected WebShare proxy
                ...(selectedProxy
                    ? [`--proxy-server=${new URL(selectedProxy).host}`]
                    : []),
            ],
        },
    },

    // ── Authenticate proxy before every navigation ────────────────────────────
    preNavigationHooks: [
        async ({ page }) => {
            if (selectedProxy) {
                const u = new URL(selectedProxy);
                await page.authenticate({
                    username : decodeURIComponent(u.username),
                    password : decodeURIComponent(u.password),
                });
            }
        },
    ],

    requestHandlerTimeoutSecs : 120,
    maxRequestRetries         : 3,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForSelector('body', { timeout: 30000 });
        await sleep(2000);

        const pageText = (await page.textContent('body')) || '';
        result.debugInfo.url     = request.url;
        result.debugInfo.bodyLen = pageText.length;

        // ── No results check ─────────────────────────────────────────────────
        const noRecord =
            /no record/i.test(pageText)  ||
            /not found/i.test(pageText)  ||
            /0 records/i.test(pageText)  ||
            /no inmates/i.test(pageText);

        if (noRecord) {
            log.info('No inmate record found.');
            result.found = false;
            return;
        }

        // ── If a result list appears, click the first inmate link ─────────────
        const firstLink = page.locator('a[href*="inquiry.asp"]').first();
        const hasLinks  = (await firstLink.count()) > 0;

        if (hasLinks) {
            log.info('Result list detected – clicking first inmate link …');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                firstLink.click(),
            ]);
            await sleep(2000);
        }

        // ── Scrape all table rows from the detail page ────────────────────────
        result.gotDetailPage = true;
        result.found         = true;

        const allRows = await page.evaluate(() => {
            const rows = [];
            document.querySelectorAll('table').forEach(tbl => {
                tbl.querySelectorAll('tr').forEach(tr => {
                    const cells = Array.from(tr.querySelectorAll('td, th'))
                        .map(td => td.innerText?.trim() || '');
                    if (cells.some(c => c.length > 0)) rows.push(cells);
                });
            });
            return rows;
        });

        result.pageData.allRows   = allRows;
        result.debugInfo.rowCount = allRows.length;
        log.info(`Scraped ${allRows.length} rows from detail page.`);
    },

    failedRequestHandler({ request, log }) {
        log.error(`Request failed after retries: ${request.url}`);
        result.debugInfo.error = `Failed: ${request.url}`;
    },
});

// ── Run ───────────────────────────────────────────────────────────────────────
await crawler.run([{ url: INQUIRY_URL }]);

// ── Push result to Apify dataset — n8n reads this via Apify API ──────────────
await Actor.pushData(result);
console.log('Done. found =', result.found);

await Actor.exit();
