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

// ── Helper: click a link and wait for new page to load ────────────────────────
async function clickAndWait(page, locator, log, label) {
    log.info(`Clicking: ${label}`);
    await locator.click();
    await page.waitForLoadState('networkidle', { timeout: 60000 });
    await sleep(3000);
    log.info(`After click [${label}] → URL: ${page.url()}`);
}

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

        // ── PAGE 1: Search results list ───────────────────────────────────────
        let pageText = (await page.textContent('body')) || '';
        log.info(`Page 1 preview: ${pageText.substring(0, 300)}`);

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

        // ── Log ALL links on page 1 ───────────────────────────────────────────
        const page1Links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map(a => ({
                text: a.innerText?.trim(),
                href: a.href,
            }))
        );
        log.info(`Page 1 links: ${JSON.stringify(page1Links)}`);

        // ── STEP 1: Click first inmate name in results list ───────────────────
        const isResultsList = /Last.*Known.*Booking|Previous.*Booking/i.test(pageText);
        if (isResultsList) {
            log.info('On results list — clicking first inmate name …');
            const nameLink = page.locator('table tbody tr td a').first();
            if ((await nameLink.count()) > 0) {
                await clickAndWait(page, nameLink, log, 'inmate name');
            } else {
                // fallback: click any table link
                const anyLink = page.locator('table a').first();
                if ((await anyLink.count()) > 0) {
                    await clickAndWait(page, anyLink, log, 'table link fallback');
                }
            }
        }

        // ── PAGE 2: Inmate summary — log all links ────────────────────────────
        pageText = (await page.textContent('body')) || '';
        log.info(`Page 2 preview: ${pageText.substring(0, 300)}`);

        const page2Links = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map(a => ({
                text: a.innerText?.trim(),
                href: a.href,
            }))
        );
        log.info(`Page 2 links: ${JSON.stringify(page2Links)}`);

        // ── STEP 2: Click "Last Known Booking" link ───────────────────────────
        const hasSummary = /Last.*Known.*Booking/i.test(pageText);
        if (hasSummary) {
            log.info('On inmate summary — clicking Last Known Booking …');

            // Try multiple selectors to find the booking link
            const selectors = [
                'a:text("Last Known Booking")',
                'a:text("Last")',
                'td:has-text("Last Known Booking") a',
                'table a[href*="booking"]',
                'table a[href*="detail"]',
                'table td:nth-child(9) a',  // Last Known Booking is 9th column
                'table td:nth-child(10) a', // or 10th
            ];

            let clicked = false;
            for (const sel of selectors) {
                try {
                    const el = page.locator(sel).first();
                    if ((await el.count()) > 0) {
                        log.info(`Found booking link with selector: ${sel}`);
                        await clickAndWait(page, el, log, `booking link [${sel}]`);
                        clicked = true;
                        break;
                    }
                } catch (e) {
                    log.info(`Selector ${sel} failed: ${e.message}`);
                }
            }

            if (!clicked) {
                // Last resort: get all links and click the one containing "Last"
                const allLinks = await page.locator('a').all();
                for (const link of allLinks) {
                    const txt = (await link.textContent() || '').trim();
                    log.info(`Checking link text: "${txt}"`);
                    if (/last/i.test(txt) || /booking/i.test(txt)) {
                        log.info(`Clicking link: "${txt}"`);
                        await clickAndWait(page, link, log, txt);
                        clicked = true;
                        break;
                    }
                }
            }

            if (!clicked) {
                log.warning('Could not find Last Known Booking link — scraping current page');
            }
        }

        // ── PAGE 3: Booking detail — scrape everything ────────────────────────
        pageText = (await page.textContent('body')) || '';
        log.info(`Final page preview: ${pageText.substring(0, 400)}`);
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

        const fullText          = await page.evaluate(() => document.body.innerText);
        result.pageData.allRows = allRows;
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
