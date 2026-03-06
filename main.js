// More reliable detail URL extraction
// Try 3 methods in order:

// Method 1: Extract from onclick attributes directly
let capturedUrl = await page.evaluate(() => {
    // Look for sh() function calls in onclick handlers
    const allElements = document.querySelectorAll('[onclick]');
    for (const el of allElements) {
        const onclick = el.getAttribute('onclick') || '';
        const match = onclick.match(/sh\(['"]([^'"]+)['"]/);
        if (match) return match[1];
    }
    return null;
});

// Method 2: Extract InmDetails URL from raw HTML
if (!capturedUrl) {
    const html = await page.content();
    const match = html.match(/InmDetails\.asp\?[^"'<>\s]+/);
    if (match) capturedUrl = match[0].replace(/&amp;/g, '&');
}

// Method 3: Intercept window.open by clicking the button
if (!capturedUrl) {
    capturedUrl = await page.evaluate(() => {
        return new Promise((resolve) => {
            window.open = (url) => { resolve(url); return null; };
            const buttons = Array.from(document.querySelectorAll('button, input[type=button], a'));
            const bookingBtn = buttons.find(b =>
                /last|booking|detail/i.test(b.innerText || b.value || '')
            );
            if (bookingBtn) { bookingBtn.click(); } else { resolve(null); }
            setTimeout(() => resolve(null), 5000);
        });
    });
}
