"""Prepare one product's watermarked media locally for the Cloudflare upload page.

The output directory contains only manifest.json, image.webp/video.mp4 and poster.webp.
The original remains on this machine and is never included in the upload bundle.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys
import uuid

from process_media import MediaError, process_image, process_video

ROOT = Path(__file__).resolve().parent.parent
PART_BYTES = 5 * 1024 * 1024
IMAGE_BYTES = 25 * 1024 * 1024
VIDEO_BYTES = 300 * 1024 * 1024
OUTPUT_BYTES = 200 * 1024 * 1024


def fingerprint(path: Path, *, parts: bool = False) -> dict:
    digest = hashlib.sha256()
    pieces = []
    with path.open("rb") as handle:
        while chunk := handle.read(PART_BYTES):
            digest.update(chunk)
            pieces.append({"bytes": len(chunk), "sha256": hashlib.sha256(chunk).hexdigest()})
    result = {"name": path.name, "bytes": path.stat().st_size, "sha256": digest.hexdigest()}
    if parts:
        result["parts"] = pieces
    return result


def prepare(source: Path, output: Path, product: str, phone: str, quality: str) -> dict:
    source, output = source.resolve(), output.resolve()
    if not re.fullmatch(r"[\w-]{1,100}", product, flags=re.ASCII):
        raise MediaError("Mã sản phẩm không hợp lệ. Dùng mã món đang quản lý, ví dụ sentai-row-84.")
    if not re.fullmatch(r"\+?\d{9,15}", phone, flags=re.ASCII):
        raise MediaError("Số điện thoại đóng dấu không hợp lệ.")
    extension = source.suffix.lower()
    kind = "image" if extension in (".jpg", ".jpeg", ".png", ".webp") else "video" if extension in (".mp4", ".mov", ".webm") else None
    if not kind:
        raise MediaError("Chỉ nhận ảnh JPEG/PNG/WebP hoặc video MP4/MOV/WebM.")
    limit = IMAGE_BYTES if kind == "image" else VIDEO_BYTES
    if not source.is_file() or not 0 < source.stat().st_size <= limit:
        raise MediaError("File nguồn trống, không tồn tại hoặc vượt giới hạn ảnh 25 MB / video 300 MB.")
    if output.exists():
        raise MediaError("Thư mục đầu ra đã tồn tại. Chọn thư mục mới để không ghi đè dữ liệu.")
    for forbidden in (ROOT / "public", ROOT / ".git"):
        if output == forbidden or forbidden in output.parents:
            raise MediaError("Hãy lưu bộ file trong data/cloudflare-media hoặc thư mục riêng, ngoài public và .git.")
    output.mkdir(parents=True, exist_ok=False)
    result = process_image(source, output, phone, quality) if kind == "image" else process_video(source, output, phone, quality)
    main = output / result["filename"]
    poster = output / "poster.webp"
    if not 0 < main.stat().st_size <= (IMAGE_BYTES if kind == "image" else OUTPUT_BYTES) or not 0 < poster.stat().st_size <= 2 * 1024 * 1024:
        raise MediaError("Bản xử lý vượt giới hạn miễn phí (ảnh 25 MiB, video 200 MiB). Hãy dùng nguồn ngắn hơn; công cụ không tự giảm chất lượng thêm.")
    original_name = re.sub(r"[\x00-\x1f\x7f]", "", source.name)[:180]
    manifest = {"version": 1, "product_id": product, "kind": kind, "quality": quality,
                "original_name": original_name, "original_bytes": source.stat().st_size,
                "width": result["width"], "height": result["height"], "duration": result["duration"], "watermark": phone,
                "files": {"main": fingerprint(main, parts=True), "poster": fingerprint(poster)}}
    # Write last: a manifest marks a complete, verified bundle.
    with (output / "manifest.json").open("x", encoding="utf-8") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
    return {"ok": True, "product_id": product, "output_directory": str(output),
            "files": ["manifest.json", main.name, "poster.webp"], "original_bytes": manifest["original_bytes"],
            "output_bytes": main.stat().st_size, "watermark": phone}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True)
    parser.add_argument("--product", required=True)
    parser.add_argument("--output-dir")
    parser.add_argument("--phone", default="0326931693")
    parser.add_argument("--quality", choices=("high", "original"), default="high")
    args = parser.parse_args()
    output = Path(args.output_dir) if args.output_dir else ROOT / "data" / "cloudflare-media" / str(uuid.uuid4())
    try:
        result = prepare(Path(args.input), output, args.product, args.phone, args.quality)
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except MediaError as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
    except Exception:
        print(json.dumps({"error": "Không chuẩn bị được media. Kiểm tra bộ xử lý, file nguồn và dung lượng trống."}, ensure_ascii=True))
    return 1


if __name__ == "__main__":
    sys.exit(main())
