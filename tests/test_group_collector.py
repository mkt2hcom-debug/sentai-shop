"""Offline collector checks: no requests reach Facebook and no real login is used."""
import asyncio
from contextlib import asynccontextmanager
import importlib.util
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("group_collector", ROOT / "scripts" / "collect_group_posts.py")
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)


class URLAndLockTests(unittest.TestCase):
    def test_group_urls_stay_on_expected_host_and_path(self):
        self.assertEqual(collector.normalize_group("https://m.facebook.com/groups/Toku.VN/?ref=share"), ("https://www.facebook.com/groups/toku.vn/", "toku.vn"))
        for value in ("http://www.facebook.com/groups/123/", "https://facebook.com.evil.test/groups/123/", "https://facebook.com@evil.test/groups/123/", "https://user@facebook.com/groups/123/", "https://www.facebook.com:444/groups/123/", "https://www.facebook.com/groups/123/posts/1/", "https://www.facebook.com/groups/discover/", "https://www.facebook.com/groups/%2e%2e/"):
            with self.subTest(value=value), self.assertRaises(collector.CollectorError):
                collector.normalize_group(value)

    def test_post_urls_require_same_group_and_post_identity(self):
        self.assertEqual(collector.canonical_post_url("/groups/123/permalink/456/?ref=share", {"123"}), "https://www.facebook.com/groups/123/posts/456/")
        self.assertEqual(collector.canonical_post_url("https://m.facebook.com/permalink.php?story_fbid=456&id=123", {"123"}), "https://www.facebook.com/groups/123/posts/456/")
        for value in ("https://evil.test/groups/123/posts/456/", "/groups/999/posts/456/", "/groups/123/posts/javascript/", "/groups/123/posts/456/likes", "/permalink.php?story_fbid=456&id=999", "/permalink.php?story_fbid=456&id=123&id=999", "javascript:alert(1)"):
            with self.subTest(value=value):
                self.assertIsNone(collector.canonical_post_url(value, {"123"}))

    def test_search_route_requires_the_actual_keyword_and_group(self):
        self.assertTrue(collector.is_search_route("https://www.facebook.com/groups/123/search/?q=DX%20Robot", "123", "DX Robot"))
        for url in ("https://www.facebook.com/", "https://www.facebook.com/groups/123/", "https://www.facebook.com/groups/123/search/?q=Other", "https://www.facebook.com/groups/999/search/?q=DX%20Robot"):
            self.assertFalse(collector.is_search_route(url, "123", "DX Robot"))

    def test_profile_lock_prevents_two_workers_and_recovers_dead_owner(self):
        with tempfile.TemporaryDirectory(prefix="sentai-collector-lock-") as directory:
            profile = Path(directory)
            with collector.ProfileLock(profile):
                self.assertTrue(collector.process_alive(os.getpid()))
                with self.assertRaises(collector.CollectorError):
                    with collector.ProfileLock(profile):
                        pass
            self.assertFalse((profile / collector.LOCK_NAME).exists())
            (profile / collector.LOCK_NAME).write_text(json.dumps({"pid": 0, "token": "expired"}), encoding="utf-8")
            with collector.ProfileLock(profile):
                self.assertEqual(json.loads((profile / collector.LOCK_NAME).read_text())["pid"], os.getpid())
            self.assertFalse((profile / collector.LOCK_NAME).exists())


class BrowserFixtureTests(unittest.TestCase):
    def test_full_scan_is_bounded_and_returns_actual_local_fixture_posts(self):
        async def run():
            from playwright.async_api import async_playwright as real_playwright

            @asynccontextmanager
            async def fixture_playwright():
                async with real_playwright() as playwright:
                    async def launch(*args, **kwargs):
                        context = await playwright.chromium.launch_persistent_context(*args, **kwargs)
                        async def route_fixture(route):
                            await route.fulfill(content_type="text/html", body='<article role="article"><a href="/groups/123/posts/456/">2 giờ</a><div data-ad-preview="message">DX Robot 850k</div></article>')
                        await context.route("**/*", route_fixture)
                        return context
                    yield SimpleNamespace(chromium=SimpleNamespace(launch_persistent_context=launch))

            with tempfile.TemporaryDirectory(prefix="sentai-collector-scan-") as directory:
                with patch("playwright.async_api.async_playwright", fixture_playwright):
                    result = await collector.scan(Path(directory), "https://www.facebook.com/groups/123/", "DX Robot", 1)
                self.assertEqual(result["status"], "partial")
                self.assertEqual(result["scanned_count"], 1)
                self.assertEqual(result["posts"][0]["text"], "DX Robot 850k")
                self.assertFalse(result["posts"][0]["text_truncated"])
        asyncio.run(run())

    def test_cards_keep_message_evidence_without_other_group_or_comments(self):
        async def run():
            from playwright.async_api import async_playwright
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch()
                try:
                    page = await browser.new_page()
                    await page.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<body></body>"))
                    await page.goto("https://www.facebook.com/groups/123/search/?q=DX")
                    await page.set_content('''<main>
                      <article role="article"><a href="/groups/123/posts/456/?ref=share">2 giờ</a>
                        <div data-ad-preview="message">DX Kiramaizin 850k<br>Đủ phụ kiện</div>
                        <article role="article"><div data-ad-preview="message">Bình luận: mua 100k</div></article>
                      </article>
                      <article role="article"><a href="/groups/123/permalink/457/">Hôm qua</a><div dir="auto">DX Kingohger 1tr2</div>
                        <article role="article"><div dir="auto">Bình luận 999k</div></article>
                      </article>
                      <article role="article"><a href="/groups/999/posts/111/">1 giờ</a><div data-ad-preview="message">DX Other 20k</div></article>
                      <div>Feed chung giá 10k không phải bài viết</div>
                    </main>''')
                    posts = await collector.extract_cards(page, {"123"})
                    self.assertEqual(len(posts), 2)
                    self.assertEqual(posts[0]["url"], "https://www.facebook.com/groups/123/posts/456/")
                    self.assertEqual(posts[0]["text_source"], "message")
                    self.assertEqual(posts[0]["published_text"], "2 giờ")
                    self.assertIsNone(posts[0]["published_at"])
                    self.assertIn("850k", posts[0]["text"])
                    self.assertNotIn("100k", posts[0]["text"])
                    self.assertEqual(posts[1]["text_source"], "article")
                    self.assertNotIn("999k", posts[1]["text"])
                    self.assertNotIn("10k", posts[1]["text"])
                finally:
                    await browser.close()
        asyncio.run(run())

    def test_login_and_empty_result_detection_do_not_claim_post_text_is_banner(self):
        async def run():
            from playwright.async_api import async_playwright
            async with async_playwright() as playwright:
                browser = await playwright.chromium.launch()
                try:
                    page = await browser.new_page()
                    await page.route("**/*", lambda route: route.fulfill(content_type="text/html", body="<body></body>"))
                    await page.goto("https://www.facebook.com/groups/123/search/?q=DX")
                    await page.set_content('<main><article role="article"><p>Không có kết quả</p></article></main>')
                    self.assertFalse(await collector.explicit_no_results(page))
                    await page.set_content('<main><p>Không tìm thấy kết quả</p></main>')
                    self.assertTrue(await collector.explicit_no_results(page))
                    await page.set_content('<main><input name="email"><input name="pass" type="password"></main>')
                    self.assertEqual(await collector.page_state(page), "needs_login")
                    await page.goto("https://www.facebook.com/checkpoint/")
                    self.assertEqual(await collector.page_state(page), "needs_login")
                finally:
                    await browser.close()
        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
