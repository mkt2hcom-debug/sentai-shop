"""Playwright smoke against the isolated Miniflare instance supplied on stdin."""
import asyncio
import json
import re
import sys
from urllib.parse import urlparse, parse_qs
from playwright.async_api import async_playwright, expect


async def main(config):
    origin = config['origin']
    stage = 'start'
    errors = []
    report = {}
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(headless=True)
        try:
            context = await browser.new_context(
                viewport={'width': 390, 'height': 844}, is_mobile=True, has_touch=True,
                device_scale_factor=1, ignore_https_errors=True,
                extra_http_headers={'DNT': '1'},
            )
            page = await context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            cdp = await context.new_cdp_session(page)
            await cdp.send('WebAuthn.enable')
            await cdp.send('WebAuthn.addVirtualAuthenticator', {'options': {
                'protocol': 'ctap2', 'transport': 'internal',
                'hasResidentKey': True, 'hasUserVerification': True,
                'isUserVerified': True, 'automaticPresenceSimulation': True,
            }})

            stage = 'public mobile homepage'
            assert (await context.request.get(origin + '/api/admin/orders')).status == 401
            await page.goto(origin, wait_until='domcontentloaded')
            await expect(page.locator('.product-card').first).to_be_visible()
            await expect(page.locator('.product-card')).to_have_count(16)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            first_image = page.locator('.product-card img').first
            await expect(first_image).to_be_visible()
            for _ in range(40):
                if await first_image.evaluate('(image) => image.complete && image.naturalWidth > 0'):
                    break
                await page.wait_for_timeout(100)
            assert await first_image.evaluate('(image) => image.complete && image.naturalWidth > 0')
            catalog = await (await context.request.get(origin + '/api/catalog')).json()
            assert len(catalog['products']) == 144 and len(catalog['families']) == 119
            report['mobile_catalog'] = '16 cards, images loaded, no horizontal overflow'

            stage = 'physical product options'
            blue = next(item for item in catalog['families'] if item['name'] == 'Blue Ressha')
            await page.goto(origin + blue['url'], wait_until='domcontentloaded')
            options = page.locator('#unit-options [data-unit]')
            await expect(options).to_have_count(2)
            await options.nth(1).click()
            await expect(page).to_have_url(re.compile(r'variant=sentai-row-85'))
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            report['product_options'] = 'Blue Ressha selected sentai-row-85'

            stage = 'one-use local bootstrap'
            await page.goto(config['bootstrap_url'], wait_until='domcontentloaded')
            await expect(page.locator('#dashboard')).to_be_visible(timeout=20000)
            assert urlparse(page.url).fragment == ''
            report['bootstrap'] = 'fragment removed, authenticated dashboard'

            stage = 'register virtual passkey'
            settings = page.locator('#passkey-settings')
            await expect(settings).to_be_visible()
            if not await settings.get_attribute('open') == '':
                await settings.locator('summary').click()
            await page.get_by_label('Tên passkey', exact=True).fill('Thiết bị kiểm thử')
            async with page.expect_response(lambda response: response.url.endswith('/api/admin/passkeys/registration/verify')) as registration:
                await page.get_by_role('button', name='Thêm passkey', exact=True).click()
            registered = await registration.value
            assert registered.status == 200, await registered.text()
            await expect(settings.locator('[role="status"]')).to_have_text('Đã thêm passkey.')
            report['registration'] = 'real WebAuthn registration verified by workerd'

            stage = 'logout and passkey login'
            await page.locator('#logout').click()
            login = page.get_by_role('button', name='Đăng nhập bằng passkey', exact=True)
            await expect(login).to_be_visible()
            assert (await context.request.get(origin + '/api/admin/orders')).status == 401
            async with page.expect_response(lambda response: response.url.endswith('/api/admin/passkeys/authentication/verify')) as authentication:
                await login.click()
            authenticated = await authentication.value
            assert authenticated.status == 200, await authenticated.text()
            await expect(page.locator('#dashboard')).to_be_visible(timeout=20000)
            assert (await context.request.get(origin + '/api/admin/orders')).status == 200
            report['passkey_login'] = 'logout revoked session; passkey created new session'

            stage = 'prepared media controls and quota'
            await page.goto(origin + '/admin/products/sentai-row-84', wait_until='domcontentloaded')
            await expect(page.locator('#studio-content')).to_be_visible()
            await expect(page.locator('#choose-files')).to_have_text('Chọn bộ file đã xử lý')
            await expect(page.locator('#choose-files')).to_be_enabled()
            await expect(page.locator('#media-files')).to_have_attribute('accept', '.json,.webp,.mp4')
            await expect(page.locator('#media-storage-quota')).to_be_visible()
            media = await (await context.request.get(origin + '/api/admin/products/sentai-row-84')).json()
            assert media['settings']['prepared_upload_ready'] is True
            assert media['settings']['storage_mode'] == 'kv'
            assert media['settings']['max_video_bytes'] == 200 * 1024 * 1024
            assert media['settings']['quota']['capacity_bytes'] == 900 * 1024 * 1024
            assert media['settings']['quota']['reserved_bytes'] == 0
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
            report['media'] = 'prepared bundle controls, 200 MiB video limit, 900 MiB KV quota'
            assert not errors, errors
            report['page_errors'] = 0
            print(json.dumps({'ok': True, **report}, ensure_ascii=False))
        except Exception as error:
            token = parse_qs(urlparse(config['bootstrap_url']).fragment).get('access', [''])[0]
            detail = str(error).replace(token, '[redacted]') if token else str(error)
            print(json.dumps({'ok': False, 'stage': stage, 'error': type(error).__name__, 'detail': detail, 'page_errors': errors}, ensure_ascii=False))
            raise SystemExit(1)
        finally:
            await browser.close()


if __name__ == '__main__':
    asyncio.run(main(json.load(sys.stdin)))
