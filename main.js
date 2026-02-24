import { Actor } from 'apify';
import { PlaywrightCrawler, sleep } from 'crawlee';

await Actor.init();

// ── Input ────────────────────────────────────────────────────────────────────
const input = await Actor.getInput();
const {
    name          = '',
    soid          = '',
    serial        = '',
    mode          = 'Inquiry',
    proxyUsername = '',
    proxyPassword = '',
    proxyList     = [],
} = input || {};

// ── Pick a random US proxy from WebShare list ─────────────────────────────────
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

console.log(`Searching  → name="${name}"  mode="${mode}"`);
console.log(`Target URL → ${INQUIRY_URL}`);
console.log(`Proxy selected: ${selectedProxy ? selectedProxy.split('@')[1] : 'none'}`);

// ── Result container ──────────────────────────────────────────────────────────
let result = {
    found         : false,
    name,
    mode,
    scrapedAt     : new Date().toISOString(),
    gotDetailPage : false,
    pageData      : { allRows: [] },
    debugInfo     : {},
};

// ── Build launch args ─────────────────────────────────────────────────────────
const proxyArgs = selectedProxy
    ? [`--proxy-server=${new URL(selectedProxy).host}`]
    : [];

// ── Crawler ───────────────────────────────────────────────────────────────────
const crawler = new PlaywrightCrawler({

    launchContext: {
        launchOptions: {
            headless : true,
            args     : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                ...proxyArgs,
            ],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            if (selectedProxy) {
                const u = new URL(selectedProxy);
                await page.authenticate({
                    username : decodeURIComponent(u.username),
                    password : decodeURIComponent(u.password),
                });
            }
            // Set realistic browser headers to avoid blocks
            await page.setExtraHTTPHeaders({
                'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language' : 'en-US,en;q=0.9',
            });
        },
    ],

    requestHandlerTimeoutSecs : 180,
    navigationTimeoutSecs     : 60,
    maxRequestRetries         : 2,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        // Wait for page to load
        await page.waitForSelector('body', { timeout: 45000 });
        await sleep(3000);

        const pageText = (await page.textContent('body')) || '';
        const pageHTML = await page.content();

        result.debugInfo.url      = request.url;
        result.debugInfo.bodyLen  = pageText.length;
        result.debugInfo.bodySnip = pageText.substring(0, 300);

        log.info(`Page loaded. Body length: ${pageText.length}`);
        log.info(`Body preview: ${pageText.substring(0, 200)}`);

        // ── No results check ──────────────────────────────────────────────────
        const noRecord =
            /no record/i.test(pageText)  ||
            /not found/i.test(pageText)  ||
            /0 records/i.test(pageText)  ||
            /no inmates/i.test(pageText);

        if (noRecord) {
            log.info('No inmate record found for this name.');
            result.found = false;
            return;
        }

        // ── Check if we landed directly on detail page ────────────────────────
        const isDetailPage =
            /Agency ID/i.test(pageText)  ||
            /booking/i.test(pageText)    ||
            /SOID/i.test(pageText)       ||
            /Offense/i.test(pageText);

        // ── If results list, click first inmate link ──────────────────────────
        const firstLink = page.locator('a[href*="inquiry.asp"], a[href*="detail"], table a').first();
        const hasLinks  = (await firstLink.count()) > 0;

        if (hasLinks && !isDetailPage) {
            log.info('Result list detected – clicking first inmate link …');
            try {
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                    firstLink.click(),
                ]);
                await sleep(3000);
            } catch (e) {
                log.warning(`Navigation after click failed: ${e.message}`);
            }
        }

        // ── Scrape ALL table rows ─────────────────────────────────────────────
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

        // ── Also grab full page text as backup ────────────────────────────────
        const fullText = await page.evaluate(() => document.body.innerText);

        result.pageData.allRows  = allRows;
        result.pageData.fullText = fullText;
        result.debugInfo.rowCount = allRows.length;

        log.info(`✅ Scraped ${allRows.length} rows from detail page.`);
        log.info(`First few rows: ${JSON.stringify(allRows.slice(0, 3))}`);
    },

    failedRequestHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url} — ${error?.message}`);
        result.debugInfo.error   = error?.message || 'Unknown error';
        result.debugInfo.failUrl = request.url;
    },
});

// ── Run ───────────────────────────────────────────────────────────────────────
await crawler.run([{ url: INQUIRY_URL }]);

// ── Push to Apify dataset ─────────────────────────────────────────────────────
await Actor.pushData(result);
console.log('Done. found =', result.found, '| gotDetailPage =', result.gotDetailPage);
if (result.debugInfo.error) {
    console.log('Error details:', result.debugInfo.error);
}

await Actor.exit();
