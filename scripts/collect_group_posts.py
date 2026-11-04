"""Read a bounded set of visible Facebook group-search results in a local profile.

No API bypass, imported cookies, automatic joining, or social writes. The person
using the shop signs in themselves in the separate --login browser. A scan reads
only cards rendered for that account. Facebook markup can change; a partial or
failed run never claims that it searched the whole group.
"""
from __future__ import annotations

import argparse
import asyncio
import ctypes
import json
import os
from pathlib import Path
import re
import secrets
import time
from urllib.parse import parse_qs, quote, unquote, urljoin, urlsplit

HOSTS = {"facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "mbasic.facebook.com"}
GROUP_PATH = re.compile(r"^/groups/([A-Za-z0-9._-]{1,120})/?$")
POST_PATH = re.compile(r"^/groups/([A-Za-z0-9._-]{1,120})/(?:posts|permalink)/([A-Za-z0-9]{1,200})/?$")
SEARCH_PATH = re.compile(r"^/groups/([A-Za-z0-9._-]{1,120})/search/?$")
RESERVED_GROUPS = {".", "..", "feed", "discover", "create", "joins", "search", "category"}
MAX_POSTS = 50
MAX_SCROLLS = 15
SCAN_SECONDS = 100
LOCK_NAME = ".sentai-collector.lock"


class CollectorError(Exception):
    """Only safe UI-facing messages; never raw browser errors or session data."""


def emit(value: dict) -> None:
    print(json.dumps(value, ensure_ascii=True, separators=(",", ":")), flush=True)


def facebook_url(raw: str):
    try:
        parsed = urlsplit(raw)
        if (parsed.scheme != "https" or parsed.hostname not in HOSTS or
                parsed.username or parsed.password or parsed.port not in (None, 443)):
            return None
        return parsed
    except (TypeError, ValueError):
        return None


def normalize_group(raw: str) -> tuple[str, str]:
    parsed = facebook_url(raw.strip())
    match = GROUP_PATH.fullmatch(unquote(parsed.path)) if parsed else None
    if not match or match[1].lower() in RESERVED_GROUPS:
        raise CollectorError("Dùng link nhóm dạng https://www.facebook.com/groups/ten-hoac-id-nhom; tên nhóm trong link chỉ gồm chữ, số, dấu chấm, gạch dưới và gạch ngang.")
    slug = match[1].lower()
    return f"https://www.facebook.com/groups/{slug}/", slug


def canonical_post_url(raw: str, slugs: set[str]) -> str | None:
    parsed = facebook_url(urljoin("https://www.facebook.com/", raw))
    if parsed is None:
        return None
    match = POST_PATH.fullmatch(unquote(parsed.path))
    post_id = None
    group_slug = None
    if match and match[1].lower() in slugs:
        group_slug, post_id = match[1].lower(), match[2]
    elif parsed.path in ("/permalink.php", "/story.php"):
        params = parse_qs(parsed.query)
        group_values = params.get("id", [])
        post_values = params.get("story_fbid", [])
        if len(group_values) == 1 and len(post_values) == 1 and group_values[0].lower() in slugs:
            group_slug, post_id = group_values[0].lower(), post_values[0]
    if not post_id or not re.fullmatch(r"(?:[0-9]+|pfbid[A-Za-z0-9]+)", post_id):
        return None
    return f"https://www.facebook.com/groups/{group_slug}/posts/{post_id}/"


def is_search_route(raw: str, slug: str, keyword: str) -> bool:
    parsed = facebook_url(raw)
    match = SEARCH_PATH.fullmatch(parsed.path) if parsed else None
    return bool(match and match[1].lower() == slug and parse_qs(parsed.query).get("q") == [keyword])


def process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        # Avoid os.kill on Windows: only inspect the process handle.
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
        kernel.GetExitCodeProcess.restype = ctypes.c_int
        kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            # Access denied means an owner might still exist; do not steal lock.
            return ctypes.get_last_error() == 5
        try:
            code = ctypes.c_ulong()
            return not kernel.GetExitCodeProcess(handle, ctypes.byref(code)) or code.value == 259
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True


class ProfileLock:
    def __init__(self, profile: Path):
        self.path = profile / LOCK_NAME
        self.token = secrets.token_hex(16)
        self.acquired = False

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        for _ in range(2):
            try:
                descriptor = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                    json.dump({"pid": os.getpid(), "token": self.token}, handle)
                self.acquired = True
                return self
            except FileExistsError:
                try:
                    previous = self.path.read_bytes()
                    owner = json.loads(previous)
                    if process_alive(int(owner["pid"])):
                        break
                    if self.path.read_bytes() == previous:
                        self.path.unlink()
                except (OSError, ValueError, KeyError, TypeError):
                    break
        raise CollectorError("Trình duyệt Facebook đang mở hoặc đang đọc nhóm. Đóng cửa sổ đăng nhập và chờ lượt đọc hiện tại kết thúc.")

    def __exit__(self, *_):
        if self.acquired:
            try:
                if json.loads(self.path.read_text(encoding="utf-8")).get("token") == self.token:
                    self.path.unlink()
            except (OSError, ValueError):
                pass


# Work on independent cards only; never save the entire feed or page as one post.
# Nested role=article nodes are typically comments and are removed in fallback.
EXTRACT_CARDS = r"""() => {
  let cards = Array.from(document.querySelectorAll('[role="article"]'))
    .filter(node => !node.parentElement?.closest('[role="article"]'));
  if (!cards.length) cards = Array.from(document.querySelectorAll('[data-pagelet^="FeedUnit_"]'));
  return cards.slice(0, 100).map(node => {
    const own = element => element.closest('[role="article"]') === node || !node.matches('[role="article"]');
    const messages = Array.from(node.querySelectorAll('[data-ad-preview="message"], [data-ad-comet-preview="message"], [data-ad-rendering-role="story_message"]')).filter(own);
    const topMessages = messages.filter(element => !messages.some(other => other !== element && other.contains(element)));
    let text = topMessages.map(element => element.innerText).join('\n');
    const source = text.trim() ? 'message' : 'article';
    if (!text.trim()) {
      const copy = node.cloneNode(true);
      copy.querySelectorAll('[role="article"], [role="textbox"], input, textarea, script, style, [aria-label^="Comment by"], [aria-label^="Bình luận của"]').forEach(element => element.remove());
      // textContent on the detached copy preserves text while respecting <br>.
      copy.querySelectorAll('br').forEach(element => element.replaceWith('\n'));
      copy.querySelectorAll('p, div[dir="auto"]').forEach(element => element.append('\n'));
      text = copy.textContent || '';
    }
    const anchors = Array.from(node.querySelectorAll('a[href]')).filter(own).slice(0, 80).map(anchor => ({href:anchor.href, text:(anchor.innerText || anchor.getAttribute('aria-label') || '').slice(0, 300)}));
    const date = node.querySelector('time[datetime]');
    text = text.trim();
    return {text:text.slice(0, 12000),text_truncated:text.length > 12000,text_source:source,anchors,published_text:date?.innerText || '',published_at:date?.getAttribute('datetime') || null};
  }).filter(card => card.text);
}"""


async def extract_cards(page, slugs: set[str]) -> list[dict]:
    cards = await page.evaluate(EXTRACT_CARDS)
    posts = []
    for card in cards:
        for anchor in card["anchors"]:
            url = canonical_post_url(anchor["href"], slugs)
            if url:
                raw_date = card.get("published_at")
                # Only retain machine-readable ISO values. Relative dates stay literal.
                date = raw_date if isinstance(raw_date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}(?:T[0-9:.+-]+Z?)?", raw_date) else None
                posts.append({"url": url, "text": card["text"], "text_source": card["text_source"], "text_truncated": bool(card.get("text_truncated")),
                              "published_text": (card.get("published_text") or anchor["text"])[:300],
                              "published_at": date})
                break
    return posts


async def page_state(page) -> str | None:
    parsed = facebook_url(page.url)
    if not parsed:
        return "unavailable"
    if re.match(r"^/(login|checkpoint|two_step_verification|recover|auth_platform)(?:/|\.php|$)", parsed.path):
        return "needs_login"
    for selector in ('input[name="email"]', 'input[name="pass"]'):
        field = page.locator(selector).first
        if await field.count() and await field.is_visible():
            return "needs_login"
    text = (await page.locator("body").inner_text(timeout=3000))[:250000].casefold()
    if any(phrase in text for phrase in ("you're temporarily blocked", "you’re temporarily blocked", "we limit how often", "bạn tạm thời bị chặn", "chúng tôi giới hạn tần suất")):
        return "limited"
    if any(phrase in text for phrase in ("log in to continue", "bạn phải đăng nhập", "đăng nhập để tiếp tục")):
        return "needs_login"
    if any(phrase in text for phrase in ("this content isn't available right now", "nội dung này hiện không hiển thị", "this page isn't available", "trang này hiện không có")):
        return "unavailable"
    return None


async def explicit_no_results(page) -> bool:
    # Exact text nodes avoid treating a post quoting these words as a result banner.
    labels = ("No results found", "We couldn't find any results", "Không tìm thấy kết quả", "Không có kết quả", "Không tìm thấy kết quả nào")
    for label in labels:
        candidate = page.get_by_text(label, exact=True).first
        if await candidate.count() and await candidate.is_visible():
            if await candidate.evaluate("node => !node.closest('[role=article], [data-pagelet^=FeedUnit_]')"):
                return True
    return False


async def expand_posts(page, deadline: float) -> None:
    labels = re.compile(r"^(?:See more|Xem thêm|Hiển thị thêm)$", re.IGNORECASE)
    cards = page.locator('[role="article"], [data-pagelet^="FeedUnit_"]')
    buttons = cards.get_by_role("button", name=labels)
    for index in range(min(await buttons.count(), 10)):
        if time.monotonic() > deadline - 3:
            break
        button = buttons.nth(index)
        try:
            if await button.is_visible():
                await button.click(timeout=700)
        except Exception:
            # A disappearing expansion control is normal during virtual scrolling.
            pass


def scan_result(status: str, message: str, posts: dict, scanned: set) -> dict:
    return {"status": status, "message": message, "posts": list(posts.values()), "scanned_count": len(scanned)}


async def scan(profile: Path, group: str, keyword: str, max_posts: int) -> dict:
    from playwright.async_api import async_playwright
    _, slug = normalize_group(group)
    slugs = {slug}
    posts: dict[str, dict] = {}
    scanned: set[str] = set()
    context = None
    result = None
    async with async_playwright() as playwright:
        try:
            async def bounded_scan():
                nonlocal context
                context = await playwright.chromium.launch_persistent_context(str(profile), headless=True, locale="vi-VN", viewport={"width": 1365, "height": 900}, timeout=15000, accept_downloads=False)
                context.set_default_timeout(2500)
                page = context.pages[0] if context.pages else await context.new_page()
                await page.goto(f"https://www.facebook.com/groups/{slug}/search/?q={quote(keyword, safe='')}", wait_until="domcontentloaded", timeout=25000)
                await page.wait_for_timeout(1500)
                redirected = facebook_url(page.url)
                if redirected:
                    match = SEARCH_PATH.fullmatch(redirected.path)
                    if match and match[1].lower() != slug:
                        return scan_result("failed", f"Facebook chuyển sang địa chỉ nhóm khác. Hãy lưu lại link nhóm https://www.facebook.com/groups/{match[1].lower()}/ rồi tìm lại để đối chiếu đúng nguồn bài.", posts, scanned)
                unchanged = 0
                deadline = time.monotonic() + SCAN_SECONDS - 30
                for _ in range(MAX_SCROLLS):
                    state = await page_state(page)
                    if state:
                        messages = {"needs_login": "Cần đăng nhập hoặc xác minh Facebook trong cửa sổ đăng nhập, rồi chạy lại.", "limited": "Facebook đang giới hạn truy cập. Đã dừng lượt đọc; hãy thử lại sau.", "unavailable": "Không mở được nội dung nhóm bằng phiên đăng nhập hiện tại. Kiểm tra link nhóm và quyền xem của tài khoản."}
                        return scan_result("needs_login" if state == "needs_login" else "partial" if posts else "failed", messages[state], posts, scanned)
                    if not is_search_route(page.url, slug, keyword):
                        return scan_result("partial" if posts else "failed", "Facebook chuyển khỏi trang tìm theo từ khóa trong nhóm. Đã dừng để tránh lấy nhầm nội dung; kiểm tra link nhóm và thử tìm thủ công trong cửa sổ đăng nhập.", posts, scanned)
                    await expand_posts(page, deadline)
                    cards = await extract_cards(page, slugs)
                    previous = len(posts)
                    for card in cards:
                        scanned.add(card["url"])
                        old = posts.get(card["url"])
                        if not old or len(card["text"]) > len(old["text"]):
                            posts[card["url"]] = card
                        if len(posts) >= max_posts:
                            return scan_result("partial", f"Đã đọc tối đa {max_posts} bài trong kết quả hiển thị. Chưa xác nhận đã đọc hết bài phù hợp trong nhóm.", posts, scanned)
                    if not posts and await explicit_no_results(page):
                        return scan_result("completed", "Facebook báo không có kết quả cho từ khóa này trong nhóm ở lượt tìm hiện tại.", posts, scanned)
                    unchanged = unchanged + 1 if len(posts) == previous else 0
                    if unchanged >= 3:
                        break
                    await page.evaluate("window.scrollBy(0, Math.max(800, window.innerHeight * 0.9))")
                    await page.wait_for_timeout(1200)
                return scan_result("partial" if posts else "failed", "Đã lưu các bài đọc được. Kết quả có thể chưa đầy đủ do giới hạn tải của Facebook." if posts else "Không nhận diện được bài viết trong kết quả hiển thị. Có thể cần đăng nhập, quyền xem nhóm hoặc cập nhật bộ đọc theo giao diện Facebook.", posts, scanned)
            result = await asyncio.wait_for(bounded_scan(), timeout=SCAN_SECONDS)
        except (TimeoutError, asyncio.TimeoutError):
            result = scan_result("partial" if posts else "failed", "Lượt đọc hết thời gian cho phép; các bài đã đọc được được giữ lại." if posts else "Facebook tải quá thời gian cho phép. Kiểm tra mạng và phiên đăng nhập rồi thử lại.", posts, scanned)
        except Exception:
            result = scan_result("partial" if posts else "failed", "Bộ đọc bị gián đoạn; đã giữ các bài thu được." if posts else "Không khởi chạy được trình đọc hoặc Facebook chưa tải được. Chạy npm run prices:setup và kiểm tra cửa sổ đăng nhập.", posts, scanned)
        finally:
            if context:
                try:
                    await asyncio.wait_for(context.close(), timeout=8)
                except Exception:
                    pass
    return result or scan_result("failed", "Lượt đọc chưa hoàn tất.", posts, scanned)


async def login(profile: Path) -> None:
    from playwright.async_api import async_playwright
    async with async_playwright() as playwright:
        context = await playwright.chromium.launch_persistent_context(str(profile), headless=False, locale="vi-VN", viewport={"width": 1280, "height": 850}, timeout=20000, accept_downloads=False)
        closed = asyncio.Event()
        context.on("close", lambda *_: closed.set())
        page = context.pages[0] if context.pages else await context.new_page()
        try:
            await page.goto("https://www.facebook.com/", wait_until="domcontentloaded", timeout=30000)
        except Exception:
            # The person can retry navigation themselves in the visible browser.
            pass
        emit({"type": "login_open", "message": "Đăng nhập Facebook trong cửa sổ vừa mở, sau đó đóng cửa sổ để bắt đầu đọc nhóm."})
        try:
            await closed.wait()
        finally:
            try:
                await context.close()
            except Exception:
                pass
        emit({"type": "login_closed", "message": "Đã đóng trình duyệt. Có thể bắt đầu lượt đọc nhóm; phiên sẽ được kiểm tra khi tìm bài."})


def check() -> dict:
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as playwright:
            if not Path(playwright.chromium.executable_path).is_file():
                return {"available": False, "message": "Chưa có Chromium. Chạy npm run prices:setup."}
        return {"available": True, "message": "Bộ đọc đã cài đặt. Đăng nhập Facebook trước lượt đọc đầu tiên."}
    except Exception:
        return {"available": False, "message": "Chưa cài Playwright/Chromium. Chạy npm run prices:setup."}


def main() -> int:
    parser = argparse.ArgumentParser(description="Đọc bài theo từ khóa trong nhóm Facebook đã có quyền xem.")
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument("--check", action="store_true")
    modes.add_argument("--login", action="store_true")
    modes.add_argument("--scan", action="store_true")
    parser.add_argument("--profile")
    parser.add_argument("--group")
    parser.add_argument("--keyword")
    parser.add_argument("--max-posts", type=int, default=20)
    args = parser.parse_args()
    if args.check:
        emit(check())
        return 0
    try:
        if not args.profile:
            raise CollectorError("Cần chỉ định thư mục phiên Facebook riêng bằng --profile.")
        profile = Path(args.profile).resolve()
        if args.scan:
            normalize_group(args.group or "")
            keyword = (args.keyword or "").strip()
            if not 2 <= len(keyword) <= 150 or any(ord(char) < 32 for char in keyword):
                raise CollectorError("Từ khóa cần từ 2 đến 150 ký tự trên một dòng.")
            if not 1 <= args.max_posts <= MAX_POSTS:
                raise CollectorError("Mỗi lượt đọc từ 1 đến 50 bài.")
        readiness = check()
        if not readiness["available"]:
            raise CollectorError(readiness["message"])
        with ProfileLock(profile):
            if args.login:
                asyncio.run(login(profile))
            else:
                emit(asyncio.run(scan(profile, args.group, keyword, args.max_posts)))
        return 0
    except KeyboardInterrupt:
        message = "Đã dừng trình duyệt Facebook."
    except CollectorError as error:
        message = str(error)
    except Exception:
        message = "Không mở được phiên trình duyệt. Kiểm tra cài đặt, thư mục phiên và đóng cửa sổ Facebook đang dùng bởi bộ đọc."
    if args.login:
        emit({"type": "error", "message": message})
        return 1
    emit({"status": "failed", "message": message, "posts": [], "scanned_count": 0})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
