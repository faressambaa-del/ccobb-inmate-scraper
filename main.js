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

        let pageText = (await page.textContent('body')) || '';

        // ── No results ────────────────────────────────────────────────────────
        if (/no record/i.test(pageText) || /not found/i.test(pageText)) {
            log.info('No inmate record found.');
            result.found = false;
            return;
        }

        result.found = true;

        // ── Dump full HTML so we can see exact link structure ─────────────────
        const fullHTML = await page.content();
        log.info(`PAGE HTML: ${fullHTML.substring(0, 3000)}`);

        // ── Get all links with full details ───────────────────────────────────
        const allLinks = await page.evaluate(() =>
            Array.from(document.querySelectorAll('a')).map((a, i) => ({
                index    : i,
                text     : a.innerText?.trim().replace(/\s+/g, ' '),
                href     : a.href,
                onclick  : a.getAttribute('onclick'),
                id       : a.id,
                className: a.className,
            }))
        );
        log.info(`ALL LINKS: ${JSON.stringify(allLinks)}`);

        // ── Try to find and navigate to InmDetails page ───────────────────────
        // Check if InmDetails link exists anywhere on page
        const detailLink = allLinks.find(l =>
            /InmDetails/i.test(l.href) ||
            /InmDetails/i.test(l.onclick || '') ||
            /BOOKING_ID/i.test(l.href) ||
            /BOOKING_ID/i.test(l.onclick || '')
        );

        if (detailLink) {
            log.info(`Found direct detail link: ${JSON.stringify(detailLink)}`);

            if (detailLink.href && !detailLink.href.endsWith('#')) {
                await page.goto(detailLink.href, { waitUntil: 'networkidle', timeout: 90000 });
            } else if (detailLink.onclick) {
                // Execute the onclick directly
                await page.evaluate((idx) => {
                    document.querySelectorAll('a')[idx].click();
                }, detailLink.index);
                await page.waitForLoadState('networkidle', { timeout: 60000 });
            }
            await sleep(3000);
            log.info(`After detail nav → URL: ${page.url()}`);

        } else {
            // ── Not on detail yet — find "Last Known Booking" cell and click it
            log.info('No direct detail link — searching for Last Known Booking cell …');

            // Get all table cells with their text and any links inside
            const tableCells = await page.evaluate(() => {
                const cells = [];
                document.querySelectorAll('td').forEach((td, i) => {
                    const a = td.querySelector('a');
                    cells.push({
                        index    : i,
                        text     : td.innerText?.trim().replace(/\s+/g, ' '),
                        hasLink  : !!a,
                        linkHref : a?.href || '',
                        linkText : a?.innerText?.trim() || '',
                        onclick  : td.getAttribute('onclick') || (a?.getAttribute('onclick') || ''),
                    });
                });
                return cells;
            });
            log.info(`TABLE CELLS: ${JSON.stringify(tableCells)}`);

            // Find cell containing "Last Known Booking"
            const lastBookingCell = tableCells.find(c =>
                /last.*known/i.test(c.text) || /last.*booking/i.test(c.text)
            );

            if (lastBookingCell) {
                log.info(`Found Last Known Booking cell: ${JSON.stringify(lastBookingCell)}`);

                if (lastBookingCell.linkHref && !lastBookingCell.linkHref.endsWith('#')) {
                    await page.goto(lastBookingCell.linkHref, { waitUntil: 'networkidle', timeout: 90000 });
                } else {
                    // Click the td cell directly at its index
                    await page.evaluate((idx) => {
                        const tds = document.querySelectorAll('td');
                        const td  = tds[idx];
                        const a   = td.querySelector('a');
                        if (a) a.click();
                        else td.click();
                    }, lastBookingCell.index);
                    await page.waitForLoadState('networkidle', { timeout: 60000 });
                }
                await sleep(3000);
                log.info(`After booking click → URL: ${page.url()}`);
            } else {
                log.warning('Could not find Last Known Booking cell');
            }
        }

        // ── Scrape final detail page ───────────────────────────────────────────
        const finalHTML = await page.content();
        log.info(`FINAL HTML: ${finalHTML.substring(0, 2000)}`);

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
        result.debugInfo.allLinks = allLinks;

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
