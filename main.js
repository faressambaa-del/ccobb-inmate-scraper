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
    await Actor.exit();
}

console.log(`Batch mode: processing ${nameList.length} names in one run`);

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

    maxConcurrency: 3,

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
            await page.route('**/*', (route) => {
                const type = route.request().resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
                    route.abort();
                } else {
                    route.continue();
                }
            });
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

        let capturedUrl = await page.evaluate(() => {
            return new Promise((resolve) => {
                window.open = (url) => { resolve(url); return null; };
                const buttons = Array.from(document.querySelectorAll('button'));
                const bookingBtn = buttons.find(b =>
                    /last/i.test(b.innerText) || /booking/i.test(b.innerText)
                );
                if (bookingBtn) { bookingBtn.click(); } else { resolve(null); }
                setTimeout(() => resolve(null), 3000);
            });
        });

        if (!capturedUrl) {
            const html  = await page.content();
            const match = html.match(/InmDetails\.asp\?[^"'<>]+/);
            if (match) capturedUrl = match[0].replace(/&amp;/g, '&');
        }

        if (capturedUrl) {
            const base    = 'http://inmate-search.cobbsheriff.org/';
            const fullUrl = capturedUrl.startsWith('http') ? capturedUrl : base + capturedUrl;
            await page.goto(fullUrl, { waitUntil: 'networkidle', timeout: 90000 });
            await sleep(1500);
        }

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

        result.pageData.allRows   = allRows;
        result.pageData.fullText  = await page.evaluate(() => document.body.innerText);
        result.debugInfo.rowCount = allRows.length;
        result.debugInfo.finalUrl = page.url();

        log.info(`✅ ${searchName} — ${allRows.length} rows scraped`);

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
