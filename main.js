import { Actor } from 'apify';
import { PlaywrightCrawler, ProxyConfiguration, sleep } from 'crawlee';

await Actor.init();

const input = await Actor.getInput();
const {
    name          = '',
    names         = [],
    soid          = '',
    serial        = '',
    mode          = 'Inquiry',
    proxyUsername = '',
    proxyPassword = '',
    proxyList     = [],
} = input || {};

const nameList = names.length > 0
    ? names
    : (name ? [{ name, original_name: name }] : []);

if (nameList.length === 0) {
    console.log('No names provided. Exiting.');
    await Actor.pushData({ found: false, error: 'No names provided' });
    await Actor.exit();
}

console.log(`Processing ${nameList.length} names in one run`);

const proxyUrls = proxyList.map(p => `http://${proxyUsername}:${proxyPassword}@${p}`);

const proxyConfiguration = proxyUrls.length > 0
    ? new ProxyConfiguration({ proxyUrls })
    : undefined;

const requests = nameList.map(entry => {
    const searchName   = typeof entry === 'string' ? entry : entry.name;
    const originalName = typeof entry === 'string' ? entry : (entry.original_name || entry.name);

    const url = [
        'http://inmate-search.cobbsheriff.org/inquiry.asp',
        `?soid=${encodeURIComponent(soid)}`,
        `&inmate_name=${encodeURIComponent(searchName)}`,
        `&serial=${encodeURIComponent(serial)}`,
        `&qry=${encodeURIComponent(mode)}`,
    ].join('');

    return { url, userData: { searchName, originalName } };
});

const crawler = new PlaywrightCrawler({

    ...(proxyConfiguration ? { proxyConfiguration } : {}),

    maxConcurrency: 1,

    launchContext: {
        launchOptions: {
            headless: true,
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

    // Increased to handle 10 names × ~45s each = ~450s needed
    requestHandlerTimeoutSecs : 600,
    navigationTimeoutSecs     : 90,
    maxRequestRetries         : 2,

    async requestHandler({ page, request, log }) {
        const { searchName, originalName } = request.userData;
        log.info(`Processing: ${searchName}`);

        let result = {
            found         : false,
            name          : searchName,
            original_name : originalName,
            mode,
            scrapedAt     : new Date().toISOString(),
            gotDetailPage : false,
            pageData      : { allRows: [] },
            debugInfo     : {},
        };

        await page.waitForLoadState('networkidle', { timeout: 60000 });
        await sleep(1500);

        const pageText = (await page.textContent('body')) || '';

        if (/no record/i.test(pageText) || /not found/i.test(pageText)) {
            log.info(`No record found for: ${searchName}`);
            await Actor.pushData(result);
            return;
        }

        result.found = true;

        // Set up popup listener BEFORE clicking
        const popupPromise = page.context().waitForEvent('page', { timeout: 12000 }).catch(() => null);

        // Try clicking any clickable element in the results table
        const clicked = await page.evaluate(() => {
            // Try all possible button/link types in order of likelihood
            const selectors = [
                'input[type=button]',
                'button',
                'a[href*="InmDetails"]',
                'td[onclick]',
                'tr[onclick]',
                '[onclick*="sh("]',
                '[onclick*="InmDetails"]',
            ];
            for (const sel of selectors) {
                const el = document.querySelector(sel);
                if (el) {
                    el.click();
                    return sel; // return which selector worked
                }
            }
            // Last resort — click first table row with data
            const rows = document.querySelectorAll('table tr');
            for (const row of rows) {
                if (row.querySelectorAll('td').length > 3) {
                    row.click();
                    return 'table row';
                }
            }
            return null;
        });

        log.info(`Clicked: ${clicked}`);

        const popup = await popupPromise;

        if (popup) {
            log.info(`Popup opened: ${popup.url()}`);
            await popup.waitForLoadState('networkidle', { timeout: 60000 });
            await sleep(1500);

            result.gotDetailPage = true;

            const allRows = await popup.evaluate(() => {
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
            result.pageData.fullText  = await popup.evaluate(() => document.body.innerText);
            result.debugInfo.rowCount    = allRows.length;
            result.debugInfo.finalUrl    = popup.url();
            result.debugInfo.clickedWith = clicked;

            log.info(`✅ ${searchName} — ${allRows.length} rows from popup`);
            await popup.close();

        } else {
            // Popup failed — try direct URL from HTML as last resort
            log.warning(`No popup for: ${searchName} — trying HTML extraction`);
            const html = await page.content();
            const match = html.match(/InmDetails\.asp\?[^"'<>\s]+/i);
            if (match) {
                const detailUrl = 'http://inmate-search.cobbsheriff.org/' + match[0].replace(/&amp;/g, '&');
                log.info(`Navigating directly to: ${detailUrl}`);
                await page.goto(detailUrl, { waitUntil: 'networkidle', timeout: 60000 });
                await sleep(1500);
                result.gotDetailPage = true;
            }

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

            result.pageData.allRows  = allRows;
            result.pageData.fullText = await page.evaluate(() => document.body.innerText);
            result.debugInfo.rowCount   = allRows.length;
            result.debugInfo.finalUrl   = page.url();
        }

        await Actor.pushData(result);
    },

    failedRequestHandler({ request, error, log }) {
        const { searchName, originalName } = request.userData;
        log.error(`Failed: ${searchName} — ${error?.message}`);
        Actor.pushData({
            found: false, name: searchName, original_name: originalName,
            scrapedAt: new Date().toISOString(), gotDetailPage: false,
            pageData: { allRows: [] }, debugInfo: { error: error?.message },
        });
    },
});

await crawler.run(requests);
console.log(`Done. Processed ${nameList.length} names.`);
await Actor.exit();
