import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, sleep } from 'crawlee';

await Actor.init();

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

const proxyUrls = proxyList.map(p => `http://${proxyUsername}:${proxyPassword}@${p}`);

const INQUIRY_URL = [
    'http://inmate-search.cobbsheriff.org/inquiry.asp',
    `?soid=${encodeURIComponent(soid)}`,
    `&inmate_name=${encodeURIComponent(name)}`,
    `&serial=${encodeURIComponent(serial)}`,
    `&qry=${encodeURIComponent(mode)}`,
].join('');

console.log(`Searching → name="${name}"  mode="${mode}"`);

let result = {
    found         : false,
    name,
    mode,
    scrapedAt     : new Date().toISOString(),
    gotDetailPage : false,
    pageData      : { allRows: [] },
    debugInfo     : {},
};

const proxyConfiguration = proxyUrls.length > 0
    ? new ProxyConfiguration({ proxyUrls })
    : undefined;

const crawler = new PlaywrightCrawler({

    ...(proxyConfiguration ? { proxyConfiguration } : {}),

    launchContext: {
        launchOptions: {
            headless : true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        },
    },

    preNavigationHooks: [
        async ({ page }) => {
            await page.setExtraHTTPHeaders({
                'User-Agent'      : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language' : 'en-US,en;q=0.9',
            });
        },
    ],

    requestHandlerTimeoutSecs : 300,
    navigationTimeoutSecs     : 90,
    maxRequestRetries         : 2,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForLoadState('networkidle', { timeout: 60000 });
        await sleep(3000);

        const pageText = (await page.textContent('body')) || '';

        if (/no record/i.test(pageText) || /not found/i.test(pageText)) {
            log.info('No inmate record found.');
            result.found = false;
            return;
        }

        result.found = true;

        // ── Extract URL from button onclick attribute ─────────────────────────
        // The button HTML is: onclick="javascript:sh("InmDetails.asp?soid=...&BOOKING_ID=...", "_New");"
        const detailUrl = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            for (const btn of buttons) {
                const onclick = btn.getAttribute('onclick') || '';
                // Match the URL inside sh("URL", ...)
                const match = onclick.match(/sh\("([^"]+InmDetails[^"]+)"/);
                if (match) return match[1];
            }
            return null;
        });

        log.info(`Extracted detail URL: ${detailUrl}`);

        if (detailUrl) {
            // Navigate directly to the full detail URL
            const fullDetailUrl = `http://inmate-search.cobbsheriff.org/${detailUrl}`;
            log.info(`Navigating to: ${fullDetailUrl}`);
            await page.goto(fullDetailUrl, { waitUntil: 'networkidle', timeout: 90000 });
            await sleep(3000);
            log.info(`Now on: ${page.url()}`);
        } else {
            log.warning('Could not extract detail URL from button onclick');
        }

        // ── Scrape the detail page ────────────────────────────────────────────
        const finalText = (await page.textContent('body')) || '';
        log.info(`Final page preview: ${finalText.substring(0, 500)}`);
        log.info(`Final URL: ${page.url()}`);

        result.gotDetailPage = true;

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

        const fullText           = await page.evaluate(() => document.body.innerText);
        result.pageData.allRows  = allRows;
        result.pageData.fullText = fullText;
        result.debugInfo.rowCount = allRows.length;
        result.debugInfo.finalUrl = page.url();
        result.debugInfo.detailUrl = detailUrl;

        log.info(`✅ Scraped ${allRows.length} rows from: ${page.url()}`);
        log.info(`All rows: ${JSON.stringify(allRows)}`);
    },

    failedRequestHandler({ request, error, log }) {
        log.error(`Failed: ${request.url} — ${error?.message}`);
        result.debugInfo.error = error?.message;
    },
});

await crawler.run([{ url: INQUIRY_URL }]);

await Actor.pushData(result);
console.log('Done. found =', result.found, '| gotDetailPage =', result.gotDetailPage);
if (result.debugInfo.error) console.log('Error:', result.debugInfo.error);

await Actor.exit();
