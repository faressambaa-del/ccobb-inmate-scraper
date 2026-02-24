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

    requestHandlerTimeoutSecs : 300,
    navigationTimeoutSecs     : 90,
    maxRequestRetries         : 2,

    async requestHandler({ page, request, log }) {
        log.info(`Processing: ${request.url}`);

        await page.waitForLoadState('networkidle', { timeout: 60000 });
        await sleep(3000);

        let pageText = (await page.textContent('body')) || '';

        // ── No results ────────────────────────────────────────────────────────
        const noRecord =
            /no record/i.test(pageText) ||
            /not found/i.test(pageText) ||
            /0 records/i.test(pageText);

        if (noRecord) {
            log.info('No inmate record found.');
            result.found = false;
            return;
        }

        result.found = true;

        // ── Extract ALL links from current page ───────────────────────────────
        const allLinks = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map(a => ({
                text : a.innerText?.trim().replace(/\n/g, ' '),
                href : a.href,
            }))
        );
        log.info(`All links on page: ${JSON.stringify(allLinks)}`);

        // ── Find "Last Known Booking" link directly by href pattern ───────────
        const bookingLink = allLinks.find(l =>
            /InmDetails/i.test(l.href) ||
            /BOOKING_ID/i.test(l.href) ||
            /last/i.test(l.text) ||
            /booking/i.test(l.text)
        );

        if (bookingLink && bookingLink.href) {
            log.info(`Found booking link: ${bookingLink.href}`);
            // Navigate directly to the detail page URL
            await page.goto(bookingLink.href, { waitUntil: 'networkidle', timeout: 90000 });
            await sleep(3000);
            log.info(`Navigated to: ${page.url()}`);
        } else {
            log.warning('No booking detail link found — checking if already on results list');

            // Try to find the inmate row link first (name link)
            const inmateLink = allLinks.find(l =>
                /inquiry/i.test(l.href) && l.href !== request.url
            );

            if (inmateLink && inmateLink.href) {
                log.info(`Navigating to inmate page: ${inmateLink.href}`);
                await page.goto(inmateLink.href, { waitUntil: 'networkidle', timeout: 90000 });
                await sleep(3000);

                // Now get links from inmate summary page
                const summaryLinks = await page.evaluate(() =>
                    Array.from(document.querySelectorAll('a')).map(a => ({
                        text : a.innerText?.trim().replace(/\n/g, ' '),
                        href : a.href,
                    }))
                );
                log.info(`Inmate summary links: ${JSON.stringify(summaryLinks)}`);

                const detailLink = summaryLinks.find(l =>
                    /InmDetails/i.test(l.href) ||
                    /BOOKING_ID/i.test(l.href) ||
                    /last/i.test(l.text) ||
                    /booking/i.test(l.text)
                );

                if (detailLink && detailLink.href) {
                    log.info(`Found detail link: ${detailLink.href}`);
                    await page.goto(detailLink.href, { waitUntil: 'networkidle', timeout: 90000 });
                    await sleep(3000);
                    log.info(`Navigated to detail: ${page.url()}`);
                }
            }
        }

        // ── Scrape final detail page ───────────────────────────────────────────
        const finalText = (await page.textContent('body')) || '';
        log.info(`Final URL: ${page.url()}`);
        log.info(`Final page preview: ${finalText.substring(0, 500)}`);

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

        log.info(`✅ Scraped ${allRows.length} rows.`);
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
