"""Compress product media and burn the shop phone into the delivered pixels.

The input remains private and untouched. Invoke with absolute input/output paths.
Only the last stdout line is JSON; diagnostics never include customer file paths.
"""

from __future__ import annotations

import argparse
from fractions import Fraction
from io import BytesIO
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import warnings


MAX_IMAGE_PIXELS = 80_000_000
MAX_VIDEO_PIXELS = 16_777_216
MAX_INPUT_BYTES = 512 * 1024 * 1024
MAX_OUTPUT_BYTES = 1024 * 1024 * 1024
MAX_VIDEO_SECONDS = 600
TIMEOUT_SECONDS = 900
RESERVED_NAMES = ("image.webp", "video.mp4", "poster.webp", "watermark.png", "poster.png")


class MediaError(Exception):
    """A safe Vietnamese explanation suitable for the upload UI."""


def binary(name: str) -> str | None:
    configured = os.environ.get(name.upper() + "_PATH", "").strip()
    if configured:
        path = Path(configured)
        return str(path.resolve()) if path.is_file() else None
    return shutil.which(name)


def run_process(args: list[str], *, timeout: int = TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(
            args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired as exc:
        raise MediaError("Xử lý quá thời gian cho phép. Hãy thử video ngắn hơn hoặc giảm độ phân giải nguồn.") from exc
    except (OSError, ValueError) as exc:
        raise MediaError("Không khởi chạy được công cụ xử lý media. Kiểm tra cài đặt FFmpeg/Python trên máy chủ.") from exc


def load_pillow():
    try:
        from PIL import Image, ImageCms, ImageDraw, ImageFont, ImageOps, features
    except ImportError as exc:
        raise MediaError("Máy chủ thiếu Pillow. Chạy python -m pip install -r requirements-media.txt.") from exc
    if not features.check("webp"):
        raise MediaError("Pillow trên máy chủ chưa hỗ trợ WebP. Hãy cài lại Pillow có bộ mã WebP.")
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    return Image, ImageCms, ImageDraw, ImageFont, ImageOps


def capability_report() -> dict:
    errors = []
    try:
        load_pillow()
        image_ready = True
    except MediaError as exc:
        image_ready = False
        errors.append(str(exc))
    ffmpeg, ffprobe = binary("ffmpeg"), binary("ffprobe")
    video_ready = bool(ffmpeg and ffprobe and image_ready)
    if not ffmpeg or not ffprobe:
        errors.append("Máy chủ cần FFmpeg và FFprobe trong PATH, hoặc FFMPEG_PATH/FFPROBE_PATH.")
    elif video_ready:
        try:
            encoders = run_process([ffmpeg, "-hide_banner", "-encoders"], timeout=15)
            probe = run_process([ffprobe, "-version"], timeout=15)
            listing = encoders.stdout.decode("utf-8", "replace")
            video_ready = encoders.returncode == 0 and probe.returncode == 0 and "libx264" in listing and re.search(r"\baac\b", listing) is not None
            if not video_ready:
                errors.append("FFmpeg cần bộ mã libx264 và AAC để xuất video tương thích trình duyệt.")
        except MediaError as exc:
            video_ready = False
            errors.append(str(exc))
    return {"ready": image_ready and video_ready, "image_ready": image_ready,
            "video_ready": video_ready, "message": " ".join(errors) or "Bộ xử lý ảnh và video đã sẵn sàng."}


def watermark_font(ImageFont, size: int):
    candidates = [
        "C:/Windows/Fonts/arialbd.ttf", "C:/Windows/Fonts/segoeuib.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc", "DejaVuSans-Bold.ttf",
    ]
    for font in candidates:
        try:
            return ImageFont.truetype(font, size)
        except OSError:
            continue
    raise MediaError("Máy chủ thiếu phông chữ để đóng dấu. Cài Arial hoặc DejaVu Sans.")


def watermark_badge(width: int, height: int, phone: str):
    Image, _, ImageDraw, ImageFont, _ = load_pillow()
    short = min(width, height)
    margin = max(3, round(short * 0.022))
    font_size = max(12, min(96, round(short * 0.039)))
    while font_size >= 5:
        font = watermark_font(ImageFont, font_size)
        bounds = font.getbbox(phone)
        pad_x, pad_y = max(3, round(font_size * .55)), max(3, round(font_size * .42))
        badge_w = bounds[2] - bounds[0] + pad_x * 2
        badge_h = bounds[3] - bounds[1] + pad_y * 2
        if badge_w <= width - margin * 2 and badge_h <= height - margin * 2:
            break
        font_size -= 1
    else:
        raise MediaError("Ảnh/video quá nhỏ để chèn số điện thoại rõ ràng.")
    badge = Image.new("RGBA", (badge_w, badge_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(badge)
    draw.rounded_rectangle((0, 0, badge_w - 1, badge_h - 1), radius=max(3, round(font_size * .3)),
                           fill=(12, 15, 25, 177), outline=(255, 255, 255, 70), width=1)
    draw.text((pad_x - bounds[0], pad_y - bounds[1]), phone, font=font, fill=(255, 255, 255, 248))
    return badge, margin


def to_srgb(image, icc_profile):
    Image, ImageCms, _, _, _ = load_pillow()
    has_alpha = image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info)
    alpha = image.convert("RGBA").getchannel("A") if has_alpha else None
    if icc_profile:
        try:
            profile = ImageCms.ImageCmsProfile(BytesIO(icc_profile))
            destination = ImageCms.createProfile("sRGB")
            mode_image = image if image.mode in ("RGB", "CMYK", "LAB") else image.convert("RGB")
            converted = ImageCms.profileToProfile(mode_image, profile, destination, outputMode="RGB")
        except Exception as exc:
            raise MediaError("Không đọc được cấu hình màu của ảnh. Hãy xuất ảnh về sRGB rồi tải lại.") from exc
    else:
        converted = image.convert("RGB")
    if alpha is not None:
        converted.putalpha(alpha)
    return converted


def process_image(source: Path, destination: Path, phone: str, quality: str) -> dict:
    Image, _, _, _, ImageOps = load_pillow()
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(source) as original:
                if original.format not in ("JPEG", "PNG", "WEBP"):
                    raise MediaError("Chỉ nhận ảnh JPEG, PNG hoặc WebP thực sự. Đổi đuôi file không đổi định dạng ảnh.")
                if getattr(original, "is_animated", False) or getattr(original, "n_frames", 1) != 1:
                    raise MediaError("Ảnh động chưa được hỗ trợ. Hãy xuất thành video MP4 hoặc ảnh tĩnh.")
                if min(original.size) < 64 or original.width * original.height > MAX_IMAGE_PIXELS:
                    raise MediaError("Ảnh cần có mỗi chiều ít nhất 64 px và không quá 80 triệu điểm ảnh.")
                icc = original.info.get("icc_profile")
                original.load()
                oriented = ImageOps.exif_transpose(original)
                image = to_srgb(oriented, icc)
    except MediaError:
        raise
    except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
        raise MediaError("Ảnh quá lớn để xử lý an toàn. Hãy xuất ảnh nhỏ hơn 80 triệu điểm ảnh.") from exc
    except Exception as exc:
        raise MediaError("Không đọc được ảnh. File có thể hỏng hoặc không đúng định dạng JPEG/PNG/WebP.") from exc
    if quality == "high":
        image.thumbnail((2560, 2560), Image.Resampling.LANCZOS)
    image = image.convert("RGBA")
    badge, margin = watermark_badge(image.width, image.height, phone)
    image.alpha_composite(badge, (image.width - badge.width - margin, image.height - badge.height - margin))
    output = destination / "image.webp"
    # No EXIF, ICC, XMP, source filename, or GPS is copied into the delivered file.
    image.save(output, "WEBP", quality=90 if quality == "high" else 95, method=6, exact=True)
    poster = image.copy()
    poster.thumbnail((512, 512), Image.Resampling.LANCZOS)
    poster.save(destination / "poster.webp", "WEBP", quality=86, method=6, exact=True)
    return {"kind": "image", "mime_type": "image/webp", "filename": output.name,
            "poster_filename": "poster.webp", "width": image.width, "height": image.height,
            "duration": None, "original_bytes": source.stat().st_size,
            "output_bytes": output.stat().st_size, "quality": quality, "watermark": phone}


def probe_video(source: Path, ffprobe: str) -> dict:
    args = [ffprobe, "-v", "error", "-protocol_whitelist", "file,pipe,data",
            "-format_whitelist", "mov,matroska,webm", "-probesize", "10000000", "-analyzeduration", "10000000",
            "-show_entries", "stream=index,codec_type,codec_name,width,height,duration,sample_aspect_ratio,color_transfer,color_primaries,avg_frame_rate:stream_side_data=rotation:stream_tags=rotate:format=format_name,duration,size",
            "-of", "json", str(source)]
    result = run_process(args, timeout=40)
    if result.returncode:
        raise MediaError("Không đọc được video. Chỉ nhận file MP4, MOV hoặc WebM hợp lệ, không nhận playlist/liên kết.")
    try:
        return json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        raise MediaError("Không xác định được thông tin video.") from exc


def positive_number(value, default=0):
    try:
        number = float(value)
        return number if math.isfinite(number) and number > 0 else default
    except (TypeError, ValueError):
        return default


def validate_video(source: Path, info: dict, quality: str) -> tuple[int, int, float]:
    fmt = info.get("format", {})
    format_names = set(fmt.get("format_name", "").split(","))
    if "mov" not in format_names and not format_names.intersection({"matroska", "webm"}):
        raise MediaError("Chỉ hỗ trợ video MP4, MOV và WebM.")
    if "mov" not in format_names:
        # Matroska and WebM share a demuxer. Verify the EBML DocType is really WebM.
        with source.open("rb") as stream:
            header = stream.read(4096)
        marker = header.find(b"\x42\x82")
        if marker < 0 or marker + 3 >= len(header):
            raise MediaError("File video không phải WebM hợp lệ.")
        first = header[marker + 2]
        length_size = next((n for n in range(1, 9) if first & (1 << (8 - n))), 0)
        if not length_size or marker + 2 + length_size > len(header):
            raise MediaError("Không đọc được định dạng WebM.")
        length_bytes = header[marker + 2:marker + 2 + length_size]
        length = int.from_bytes(length_bytes, "big") & ((1 << (7 * length_size)) - 1)
        start = marker + 2 + length_size
        if header[start:start + length].lower() != b"webm":
            raise MediaError("Video Matroska/MKV chưa được hỗ trợ. Hãy xuất thành MP4 hoặc WebM.")
    video = next((stream for stream in info.get("streams", []) if stream.get("codec_type") == "video"), None)
    if not video:
        raise MediaError("File không có luồng hình ảnh video.")
    width, height = int(video.get("width", 0)), int(video.get("height", 0))
    if min(width, height) < 64 or max(width, height) > 8192 or width * height > MAX_VIDEO_PIXELS:
        raise MediaError("Video cần có mỗi chiều ít nhất 64 px và không quá 16 triệu điểm ảnh mỗi khung hình.")
    duration = positive_number(video.get("duration")) or positive_number(fmt.get("duration"))
    if not duration or duration > MAX_VIDEO_SECONDS:
        raise MediaError("Video cần có thời lượng xác định và không dài quá 10 phút.")
    if video.get("color_transfer") in ("smpte2084", "arib-std-b67") or video.get("color_primaries") in ("bt2020", "smpte431", "smpte432"):
        raise MediaError("Video HDR/màu rộng chưa được hỗ trợ. Hãy xuất video SDR (sRGB/Rec.709) để giữ màu chính xác.")
    try:
        fps = float(Fraction(video.get("avg_frame_rate", "0/1")))
    except (ValueError, ZeroDivisionError):
        fps = 0
    if fps > 120:
        raise MediaError("Video trên 120 khung hình/giây chưa được hỗ trợ. Hãy xuất bản 30 hoặc 60 fps.")
    try:
        ratio = float(Fraction(video.get("sample_aspect_ratio", "1:1").replace(":", "/")))
    except (ValueError, ZeroDivisionError):
        ratio = 1
    if not .1 <= ratio <= 10:
        raise MediaError("Video có tỷ lệ điểm ảnh không hợp lệ.")
    # Normalize non-square pixels without increasing either source dimension.
    display_width = width * min(1, ratio)
    display_height = height / max(1, ratio)
    rotation = video.get("tags", {}).get("rotate", 0)
    for side_data in video.get("side_data_list", []):
        if "rotation" in side_data:
            rotation = side_data["rotation"]
    try:
        rotation = float(rotation) % 360
    except (TypeError, ValueError):
        raise MediaError("Không đọc được hướng xoay của video.")
    if abs(rotation / 90 - round(rotation / 90)) > .01:
        raise MediaError("Video có góc xoay không chuẩn. Hãy xuất lại video theo chiều dọc hoặc ngang.")
    if round(rotation / 90) % 2:
        display_width, display_height = display_height, display_width
    factor = min(1, 1920 / max(display_width, display_height)) if quality == "high" else 1
    out_width = max(2, int(display_width * factor) // 2 * 2)
    out_height = max(2, int(display_height * factor) // 2 * 2)
    return out_width, out_height, duration


def process_video(source: Path, destination: Path, phone: str, quality: str) -> dict:
    Image, _, _, _, _ = load_pillow()
    ffmpeg, ffprobe = binary("ffmpeg"), binary("ffprobe")
    if not ffmpeg or not ffprobe:
        raise MediaError("Máy chủ cần FFmpeg và FFprobe để nén, đóng dấu video.")
    info = probe_video(source, ffprobe)
    width, height, duration = validate_video(source, info, quality)
    badge, margin = watermark_badge(width, height, phone)
    badge_path = destination / "watermark.png"
    badge.save(badge_path, "PNG")
    output = destination / "video.mp4"
    filters = (f"[0:v:0]scale={width}:{height}:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1[main];"
               f"[main][1:v:0]overlay=x=main_w-overlay_w-{margin}:y=main_h-overlay_h-{margin}:"
               "eof_action=repeat:repeatlast=1:format=auto,format=yuv420p[video]")
    args = [ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-xerror", "-y",
            "-threads", "2", "-protocol_whitelist", "file,pipe,data", "-format_whitelist", "mov,matroska,webm",
            "-i", str(source), "-protocol_whitelist", "file,pipe,data", "-i", str(badge_path),
            "-filter_complex_threads", "1", "-filter_complex", filters,
            "-map", "[video]", "-map", "0:a:0?", "-map_metadata", "-1", "-map_chapters", "-1",
            "-metadata:s:v:0", "rotate=0", "-c:v", "libx264", "-preset", "medium",
            "-crf", "18" if quality == "high" else "17", "-threads", "2", "-pix_fmt", "yuv420p",
            "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709",
            "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", "-fps_mode", "vfr",
            "-t", str(duration), "-fs", str(MAX_OUTPUT_BYTES), str(output)]
    result = run_process(args)
    if result.returncode or not output.is_file() or output.stat().st_size == 0:
        raise MediaError("Không nén được video. File có thể hỏng hoặc bộ mã nguồn không được hỗ trợ.")
    if output.stat().st_size >= MAX_OUTPUT_BYTES - 1_000_000:
        raise MediaError("Video sau xử lý vượt giới hạn 1 GB. Hãy dùng chế độ tối ưu hoặc video ngắn hơn.")
    final_info = probe_video(output, ffprobe)
    final_stream = next((s for s in final_info.get("streams", []) if s.get("codec_type") == "video"), {})
    final_duration = positive_number(final_stream.get("duration")) or positive_number(final_info.get("format", {}).get("duration"))
    if abs(final_duration - duration) > max(1, duration * .02):
        raise MediaError("Video xử lý không đủ thời lượng. Hãy tải lại file gốc hoàn chỉnh.")
    if final_stream.get("width") != width or final_stream.get("height") != height:
        raise MediaError("Kích thước video sau xử lý không khớp. Vui lòng thử file xuất khác.")
    poster_png = destination / "poster.png"
    result = run_process([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
                          "-protocol_whitelist", "file,pipe,data", "-ss", str(min(0.5, duration / 4)),
                          "-i", str(output), "-frames:v", "1", "-threads", "2", str(poster_png)], timeout=60)
    if result.returncode or not poster_png.is_file():
        raise MediaError("Không tạo được ảnh xem trước của video.")
    with Image.open(poster_png) as poster:
        poster.thumbnail((512, 512), Image.Resampling.LANCZOS)
        poster.save(destination / "poster.webp", "WEBP", quality=86, method=6)
    badge_path.unlink()
    poster_png.unlink()
    return {"kind": "video", "mime_type": "video/mp4", "filename": output.name,
            "poster_filename": "poster.webp", "width": width, "height": height,
            "duration": round(final_duration, 3), "original_bytes": source.stat().st_size,
            "output_bytes": output.stat().st_size, "quality": quality, "watermark": phone}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--input")
    parser.add_argument("--output-dir")
    parser.add_argument("--kind", choices=("image", "video"))
    parser.add_argument("--phone")
    parser.add_argument("--quality", choices=("high", "original"), default="high")
    args = parser.parse_args()
    if args.check:
        print(json.dumps(capability_report(), ensure_ascii=True))
        return 0
    generated_paths = []
    try:
        if not all((args.input, args.output_dir, args.kind, args.phone)):
            raise MediaError("Thiếu thông tin đầu vào, thư mục đầu ra, loại media hoặc số điện thoại.")
        phone = re.sub(r"[\s().-]", "", args.phone)
        if not re.fullmatch(r"\+?\d{9,15}", phone):
            raise MediaError("Số điện thoại dùng làm watermark không hợp lệ.")
        source, destination = Path(args.input).resolve(), Path(args.output_dir).resolve()
        if not source.is_file() or source.stat().st_size < 1 or source.stat().st_size > MAX_INPUT_BYTES:
            raise MediaError("Không tìm thấy file nguồn hoặc file vượt giới hạn 512 MB.")
        destination.mkdir(parents=True, exist_ok=True)
        candidates = [destination / name for name in RESERVED_NAMES]
        if any(path.exists() for path in candidates) or source in candidates:
            raise MediaError("Thư mục xử lý đã có tập tin. Vui lòng tạo một lượt tải lên mới.")
        generated_paths = candidates
        result = process_image(source, destination, phone, args.quality) if args.kind == "image" else process_video(source, destination, phone, args.quality)
        if result["output_bytes"] > MAX_OUTPUT_BYTES:
            raise MediaError("File sau xử lý vượt giới hạn dung lượng cho phép.")
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except MediaError as exc:
        message = str(exc)
    except Exception:
        message = "Xử lý media thất bại. Kiểm tra dung lượng trống và định dạng file rồi thử lại."
    for path in generated_paths:
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            pass
    print(json.dumps({"error": message}, ensure_ascii=True))
    return 1


if __name__ == "__main__":
    sys.exit(main())
