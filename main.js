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

// ── Pick a random proxy ───────────────────────────────────────────────────────
function getRandomProxy() {
    if (!proxyList || proxyList.length === 0) return null;
    const proxy = proxyList[Math.floor(Math.random() * proxyList.length)];
    return proxy; // returns "ip:port"
}

const selectedProxyHost = getRandomProxy();

const INQUIRY_URL = [
    'http://inmate-search.cobbsheriff.org/inquiry.asp',
    `?soid=${encodeURIComponent(soid)}`,
    `&inmate_name=${encodeURIComponent(name)}`,
    `&serial=${encodeURIComponent(serial)}`,
    `&qry=${encodeURIComponent(mode)}`,
].join('');

console.log(`Searching  → name="${name}"  mode="${mode}"`);
console.log(`Target URL → ${INQUIRY_URL}`);
console.log(`Proxy selected: ${selectedProxyHost || 'none'}`);

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

// ── Crawler — proxy auth passed via launchOptions correctly ───────────────────
const crawler = new PlaywrightCrawler({

    launchContext: {
        launchOptions: {
            headless : true,
            args     : [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                // ✅ Correct way to set proxy in Playwright
                ...(selectedProxyHost ? [`--proxy-server=http://${selectedProxyHost}`] : []),
            ],
        },
        // ✅ Correct way to pass proxy credentials in Crawlee/Playwright
        ...(selectedProxyHost && proxyUsername ? {
            proxyUrl: `http://${proxyUsername}:${proxyPassword}@${selectedProxyHost}`,
        } : {}),
    },

    requestHandlerTimeoutSecs : 180,
    navigationTimeoutSecs     : 60,
    maxRequestRetries         : 2,

    preNavigationHooks: [
        async ({ page }) => {
            await page.setExtraHTTPHeaders({
                'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language' : 'en-US,en;q=0.9',
            });
        },
    ],

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForSelector('body', { timeout: 45000 });
        await sleep(3000);

        const pageText = (await page.textContent('body')) || '';

        result.debugInfo.url      = request.url;
        result.debugInfo.bodyLen  = pageText.length;
        result.debugInfo.bodySnip = pageText.substring(0, 500);

        log.info(`Page loaded. Length: ${pageText.length}`);
        log.info(`Preview: ${pageText.substring(0, 300)}`);

        // ── No results check ──────────────────────────────────────────────────
        const noRecord =
            /no record/i.test(pageText) ||
            /not found/i.test(pageText) ||
            /0 records/i.test(pageText) ||
            /no inmates/i.test(pageText);

        if (noRecord) {
            log.info('No inmate record found.');
            result.found = false;
            return;
        }

        // ── Detect if already on detail page ──────────────────────────────────
        const isDetailPage =
            /Agency ID/i.test(pageText) ||
            /Offense/i.test(pageText)   ||
            /Bond/i.test(pageText);

        // ── If results list, click first inmate link ──────────────────────────
        if (!isDetailPage) {
            const firstLink = page.locator('a[href*="inquiry.asp"], table a').first();
            const hasLinks  = (await firstLink.count()) > 0;

            if (hasLinks) {
                log.info('Result list detected – clicking first inmate link …');
                try {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                        firstLink.click(),
                    ]);
                    await sleep(3000);
                } catch (e) {
                    log.warning(`Click navigation failed: ${e.message}`);
                }
            }
        }

        // ── Scrape all table rows ─────────────────────────────────────────────
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

        const fullText = await page.evaluate(() => document.body.innerText);

        result.pageData.allRows  = allRows;
        result.pageData.fullText = fullText;
        result.debugInfo.rowCount = allRows.length;

        log.info(`✅ Scraped ${allRows.length} rows.`);
        log.info(`Sample rows: ${JSON.stringify(allRows.slice(0, 3))}`);
    },

    failedRequestHandler({ request, error, log }) {
        log.error(`Request failed: ${request.url} — ${error?.message}`);
        result.debugInfo.error   = error?.message || 'Unknown error';
        result.debugInfo.failUrl = request.url;
    },
});

// ── Run ───────────────────────────────────────────────────────────────────────
await crawler.run([{ url: INQUIRY_URL }]);

await Actor.pushData(result);
console.log('Done. found =', result.found, '| gotDetailPage =', result.gotDetailPage);
if (result.debugInfo.error) console.log('Error:', result.debugInfo.error);

await Actor.exit();
