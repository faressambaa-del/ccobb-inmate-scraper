import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, sleep } from 'crawlee';

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

const proxyUrls = proxyList.map(p => `http://${proxyUsername}:${proxyPassword}@${p}`);

const INQUIRY_URL = [
    'http://inmate-search.cobbsheriff.org/inquiry.asp',
    `?soid=${encodeURIComponent(soid)}`,
    `&inmate_name=${encodeURIComponent(name)}`,
    `&serial=${encodeURIComponent(serial)}`,
    `&qry=${encodeURIComponent(mode)}`,
].join('');

console.log(`Searching → name="${name}"  mode="${mode}"`);
console.log(`URL: ${INQUIRY_URL}`);

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

    requestHandlerTimeoutSecs : 180,
    navigationTimeoutSecs     : 60,
    maxRequestRetries         : 2,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForSelector('body', { timeout: 45000 });
        await sleep(3000);

        const pageText = (await page.textContent('body')) || '';
        result.debugInfo.url      = request.url;
        result.debugInfo.bodyLen  = pageText.length;
        result.debugInfo.bodySnip = pageText.substring(0, 500);

        log.info(`Page length: ${pageText.length}`);
        log.info(`Preview: ${pageText.substring(0, 400)}`);

        // ── No results ────────────────────────────────────────────────────────
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

        result.found = true;

        // ── STEP 1: If name search results list — click first name link ───────
        const isResultsList = /Last.*Known.*Booking|Previous.*Booking/i.test(pageText);
        if (isResultsList) {
            log.info('Results list detected — clicking first inmate name link …');
            // Click the first inmate name link in the results table
            const nameLink = page.locator('table a').first();
            if ((await nameLink.count()) > 0) {
                try {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                        nameLink.click(),
                    ]);
                    await sleep(3000);
                    log.info(`Navigated to: ${page.url()}`);
                } catch (e) {
                    log.warning(`Name link click failed: ${e.message}`);
                }
            }
        }

        // ── STEP 2: Now on inmate summary page — click "Last Known Booking" ───
        const pageText2 = (await page.textContent('body')) || '';
        const hasBookingLink = /Last.*Known.*Booking/i.test(pageText2);

        if (hasBookingLink) {
            log.info('Inmate summary page detected — clicking Last Known Booking …');
            try {
                // Find the "Last Known Booking" link
                const bookingLink = page.locator('a:has-text("Last"), a:has-text("Booking"), td a').first();
                if ((await bookingLink.count()) > 0) {
                    await Promise.all([
                        page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                        bookingLink.click(),
                    ]);
                    await sleep(3000);
                    log.info(`Navigated to booking detail: ${page.url()}`);
                } else {
                    // Try clicking any link in the page that leads to booking detail
                    const allLinks = await page.locator('a[href*="booking"], a[href*="detail"], a[href*="inquiry"]').all();
                    log.info(`Found ${allLinks.length} potential booking links`);
                    if (allLinks.length > 0) {
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 60000 }),
                            allLinks[0].click(),
                        ]);
                        await sleep(3000);
                    }
                }
            } catch (e) {
                log.warning(`Booking link click failed: ${e.message}`);
            }
        }

        // ── STEP 3: Scrape the final detail page ──────────────────────────────
        const finalText = (await page.textContent('body')) || '';
        log.info(`Final page preview: ${finalText.substring(0, 400)}`);

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

        // ── Also capture all links on final page for debugging ────────────────
        const allLinks = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map(a => ({
                text : a.innerText?.trim(),
                href : a.href,
            }))
        );

        const fullText = await page.evaluate(() => document.body.innerText);

        result.pageData.allRows   = allRows;
        result.pageData.fullText  = fullText;
        result.debugInfo.rowCount = allRows.length;
        result.debugInfo.allLinks = allLinks;
        result.debugInfo.finalUrl = page.url();

        log.info(`✅ Scraped ${allRows.length} rows from final page.`);
        log.info(`Final URL: ${page.url()}`);
        log.info(`Sample rows: ${JSON.stringify(allRows.slice(0, 5))}`);
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
