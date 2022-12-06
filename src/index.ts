import puppeteerExtra from 'puppeteer-extra';
import pluginStealth from 'puppeteer-extra-plugin-stealth';
import aws from 'aws-sdk';
import nodeFetch from 'node-fetch';
import { timeout } from 'cobalt-int-common';
import { Page } from 'puppeteer';

const secretsManager = new aws.SecretsManager({
    region: 'us-east-1'
});

(async () => {
    puppeteerExtra.use(pluginStealth());

    const browser = await puppeteerExtra
        .launch({
            headless: false,
            devtools: true,
            args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process', '--window-size=1920,1080']
        });
    const page = await browser.newPage();

    // For geetest we have to block the js that loads the test.
    // If the js gets a chance to render the test, we can't solve it anymore
    await page.setRequestInterception(true);
    let firstTryJSBlock = true;
    page.on('request', async (request) => {
        if (request.url().includes('gt.js') && firstTryJSBlock) {
            await request.abort();
            firstTryJSBlock = false;
        }
        else {
            await request.continue();
        }
    });

    const url = 'https://esos.nv.gov/EntitySearch/OnlineEntitySearch';
    await page.goto(url);
    const captchaIframe = await page.$('#main-iframe');

    if (captchaIframe) {
        try {
            await handleGeeTest(page, url);
        }
        catch (e) {
            await browser.close();
            throw e;
        }
    }

    await page.waitForTimeout(55000);

    await browser.close();
})();

async function handleGeeTest(page: Page, url: string) {
    let geeTestValues;
    let firstTry = true;
    // Now that we've blocked the js response, we are going to pluck the challenge and gt values from this page so we can send it off to be solved.
    page.on('response', async (response) => {
        // This will get triggered when we make the request again and we don't want to do that.
        if (response.url().includes('GEE') && firstTry) {
            firstTry = false;
            geeTestValues = await page.evaluate(async (url: string) => {
                const geeTestResponse = await fetch(url);
                const geeTestValues = await geeTestResponse.json();
                console.log('response', geeTestValues);

                return geeTestValues;
            }, response.url());
        }
    });

    // Get proxy credentials to use them for solving the captcha
    const proxyApiCredentials = await secretsManager.getSecretValue({
        SecretId: 'proxyApiCredentials'
    }).promise();
    const proxyApiCredentialsSecrets: any = JSON.parse(proxyApiCredentials.SecretString);

    await page.waitForTimeout(120000);
    const frames = page.frames();
    const myFrame = frames.find((frame) => frame.url().includes('Incapsula_Resource'));
    const captchaHtml = await myFrame.$eval('.error-content', (el) => el.innerHTML);
    const submissionParamsBeforeSplit = captchaHtml.split('/_Incapsula_Resource?SWCGHOEL=gee&')[1].split('", true);')[0];
    const dai = submissionParamsBeforeSplit.split('dai=')[1].split('&')[0];
    const cts = submissionParamsBeforeSplit.split('&cts=')[1];

    const solvedCaptcha = await solveGeeTest(geeTestValues, proxyApiCredentialsSecrets.captchaToken, url);

    if (!solvedCaptcha?.geetest_challenge) {
        throw 'failed to solve captcha';
    }

    await page.evaluate(async (solvedCaptcha: any, dai: string, cts: string) => {
        // This is their code that I copied so I could perfectly emulate how they submitted these values.
        let xhr2;
        const post_body = "geetest_challenge=" + solvedCaptcha.geetest_challenge + "&geetest_validate=" + solvedCaptcha.geetest_validate + "&geetest_seccode=" + solvedCaptcha.geetest_seccode;
        if (window.XMLHttpRequest) {
            xhr2 = new XMLHttpRequest;
        }
        else {
            xhr2 = new ActiveXObject("Microsoft.XMLHTTP");
        }
        xhr2.open("POST", `/_Incapsula_Resource?SWCGHOEL=gee&dai=${dai}&cts=${cts}`, true);
        xhr2.setRequestHeader("Content-Type", "application/x-www-form-urlencoded");
        xhr2.onreadystatechange = () => {
            if (xhr2.readyState == 4) {
                if (xhr2.status == 200) {
                    window.parent.location.reload();
                } else {
                    window.parent.location.reload();
                }
            }
        }
        xhr2.send(post_body);
    }, solvedCaptcha, dai, cts);

    console.log('sent captcha results');
    await page.waitForTimeout(1500);

    await page.goto(url);
}

async function solveGeeTest(geeTestValues: any, captchaToken: string, pageUrl: string) {
    console.log('geeTestValues', geeTestValues);
    const url = `http://2captcha.com/in.php?key=${captchaToken}&method=geetest&gt=${geeTestValues.gt}&challenge=${geeTestValues.challenge}&pageurl=${pageUrl}&json=1`;
    const response = await nodeFetch(url);
    const json: any = await response.json();
    console.log('json', json);

    const captchaId = json.request;
    let complete = false;
    let attempt = 0;
    let captchaJson;

    // It takes a bit of time to complete the geetest so we have to poll for it.
    // 175 seconds seems like enough (35 * 5)
    while (!complete && attempt < 35) {
        await timeout(5000);
        attempt++;
        const captchaUrl = `http://2captcha.com/res.php?key=${captchaToken}&action=get&id=${captchaId}&json=1`;
        const captchaResponse = await nodeFetch(captchaUrl);
        captchaJson = await captchaResponse.json();
        console.log('captchaJson', captchaJson, 'attempt #', attempt);
        if (captchaJson.status === 1 || captchaJson.request !== 'CAPCHA_NOT_READY') {
            complete = true;
        }
    }

    return captchaJson?.request;
}
