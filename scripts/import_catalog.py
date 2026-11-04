"""Import Sentai products and their embedded photos without modifying the workbook.

Uses only Python's standard library. Images are copied byte-for-byte; an image is
attached to the product on its drawing's anchor row, never guessed by filename.
Run from any directory: python scripts/import_catalog.py [path/to/workbook.xlsx]
"""

from __future__ import annotations

import argparse
from collections import Counter, defaultdict
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import sys
import unicodedata
import xml.etree.ElementTree as ET
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[1]
NS = {
    "s": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "p": "http://schemas.openxmlformats.org/package/2006/relationships",
    "xdr": "http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
}


def text_value(value):
    return "" if value is None else str(value).strip()


def fold(value):
    value = unicodedata.normalize("NFD", text_value(value).lower())
    return "".join(c for c in value if unicodedata.category(c) != "Mn").replace("đ", "d")


def related_path(owner, target):
    """Resolve an internal OOXML relationship relative to its owning part."""
    resolved = posixpath.normpath(
        target.lstrip("/") if target.startswith("/")
        else posixpath.join(posixpath.dirname(owner), target)
    )
    if resolved.startswith("../") or resolved == "..":
        raise ValueError(f"Relationship escapes workbook: {target}")
    return resolved


def relationships(archive, owner):
    part = PurePosixPath(owner)
    filename = str(part.parent / "_rels" / (part.name + ".rels"))
    if filename not in archive.namelist():
        return {}
    result = {}
    for rel in ET.fromstring(archive.read(filename)):
        if rel.get("TargetMode") != "External":
            result[rel.get("Id")] = related_path(owner, rel.get("Target", ""))
    return result


def cell_value(cell, shared_strings):
    kind = cell.get("t")
    if kind == "inlineStr":
        return "".join(node.text or "" for node in cell.findall(".//s:t", NS))
    value = cell.find("s:v", NS)
    if value is None or value.text is None:
        return None
    if kind == "s":
        return shared_strings[int(value.text)]
    return value.text


def read_price(raw):
    """Accept positive integer VND amounts; missing/ambiguous values stay null."""
    if raw in (None, ""):
        return None
    try:
        amount = Decimal(str(raw))
        if amount.is_finite() and amount > 0 and amount == amount.to_integral_value():
            return int(amount)
    except InvalidOperation:
        pass
    return None


def get_availability(condition, total):
    source = fold(f"{condition} {total}")
    if any(marker in source for marker in ("da ban", "het hang", "sold out", "sold_out")):
        return "sold_out"
    if any(marker in source for marker in ("con hang", "in stock")):
        return "available"
    return "unknown"


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def import_catalog(workbook):
    warnings = []
    products = []
    extracted_media = {}
    image_associations = []
    sheet_names = []
    image_dir = ROOT / "public" / "images" / "products"
    image_dir.mkdir(parents=True, exist_ok=True)

    with ZipFile(workbook) as archive:
        strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            for item in ET.fromstring(archive.read("xl/sharedStrings.xml")):
                strings.append("".join(node.text or "" for node in item.findall(".//s:t", NS)))
        workbook_xml = ET.fromstring(archive.read("xl/workbook.xml"))
        sheet_links = relationships(archive, "xl/workbook.xml")
        sheets = workbook_xml.findall("s:sheets/s:sheet", NS)

        for sheet in sheets:
            sheet_name = sheet.get("name", "Sheet")
            sheet_names.append(sheet_name)
            sheet_path = sheet_links[sheet.get("{" + NS["r"] + "}id")]
            sheet_xml = ET.fromstring(archive.read(sheet_path))
            sheet_rels = relationships(archive, sheet_path)
            images_by_row = defaultdict(list)

            for drawing_node in sheet_xml.findall("s:drawing", NS):
                drawing_path = sheet_rels[drawing_node.get("{" + NS["r"] + "}id")]
                drawing_rels = relationships(archive, drawing_path)
                drawing_xml = ET.fromstring(archive.read(drawing_path))
                for anchor in drawing_xml:
                    origin = anchor.find("xdr:from", NS)
                    blip = anchor.find(".//a:blip", NS)
                    if origin is None or blip is None:
                        warnings.append({"type": "unmapped_drawing", "sheet": sheet_name})
                        continue
                    row_number = int(origin.findtext("xdr:row", default="0", namespaces=NS)) + 1
                    column_number = int(origin.findtext("xdr:col", default="0", namespaces=NS)) + 1
                    relation = blip.get("{" + NS["r"] + "}embed")
                    media_path = drawing_rels.get(relation)
                    if not media_path:
                        warnings.append({"type": "unmapped_image", "sheet": sheet_name, "row": row_number})
                        continue
                    if column_number != 4:
                        warnings.append({"type": "image_outside_image_column", "sheet": sheet_name,
                                         "row": row_number, "column": column_number})
                        continue
                    if media_path not in extracted_media:
                        original_name = PurePosixPath(media_path).name
                        suffix = PurePosixPath(original_name).suffix.lower()
                        if suffix not in {".jpg", ".jpeg", ".png", ".gif", ".webp"}:
                            warnings.append({"type": "unsupported_image_format", "source": media_path})
                            continue
                        content = archive.read(media_path)
                        # Include a digest to avoid collisions across drawings or replacement workbooks.
                        digest = hashlib.sha256(content).hexdigest()[:12]
                        filename = f"{PurePosixPath(original_name).stem}-{digest}{suffix}"
                        destination = image_dir / filename
                        if not destination.exists() or destination.read_bytes() != content:
                            destination.write_bytes(content)
                        extracted_media[media_path] = "/images/products/" + filename
                    url = extracted_media[media_path]
                    if url not in images_by_row[row_number]:
                        images_by_row[row_number].append(url)
                    image_associations.append({"sheet": sheet_name, "row": row_number,
                                               "source": media_path, "url": url})

            product_rows = set()
            for row in sheet_xml.findall("s:sheetData/s:row", NS):
                row_number = int(row.get("r"))
                if row_number == 1:
                    continue
                values = {}
                for cell in row.findall("s:c", NS):
                    column = re.sub(r"\d+", "", cell.get("r", ""))
                    values[column] = cell_value(cell, strings)
                name = text_value(values.get("E"))
                if not name:
                    continue
                condition = text_value(values.get("G"))
                original_price = values.get("I")
                price = read_price(original_price)
                total = text_value(values.get("J"))
                source_slug = re.sub(r"[^a-z0-9]+", "-", fold(sheet_name)).strip("-")
                identifier = f"sentai-row-{row_number}" if len(sheets) == 1 else f"sentai-{source_slug}-row-{row_number}"
                products.append({
                    "id": identifier,
                    "sku": text_value(values.get("B")) or None,
                    "name": name,
                    "series": text_value(values.get("C")),
                    "category": "Mecha" if sheet_name.lower() == "mecha" else sheet_name,
                    "price_vnd": price,
                    "price_original": text_value(original_price) or None,
                    "availability": get_availability(condition, total),
                    "stock_quantity": None,
                    "condition": condition,
                    "description": text_value(values.get("H")),
                    "search_key": text_value(values.get("F")),
                    "source_total_original": total or None,
                    "source_sheet": sheet_name,
                    "source_row": row_number,
                    "images": images_by_row.get(row_number, []),
                })
                product_rows.add(row_number)
                if original_price not in (None, "") and price is None:
                    warnings.append({"type": "ambiguous_price", "sheet": sheet_name,
                                     "row": row_number, "value": original_price})
            for row_number in images_by_row:
                if row_number not in product_rows:
                    warnings.append({"type": "image_without_product", "sheet": sheet_name, "row": row_number})

    sku_rows = defaultdict(list)
    for product in products:
        if product["sku"]:
            sku_rows[product["sku"]].append(product["source_row"])
    duplicates = {sku: rows for sku, rows in sorted(sku_rows.items()) if len(rows) > 1}
    missing_prices = [p["source_row"] for p in products if p["price_vnd"] is None]
    missing_skus = [p["source_row"] for p in products if p["sku"] is None]
    missing_images = [p["source_row"] for p in products if not p["images"]]
    availability_counts = dict(Counter(p["availability"] for p in products))
    warnings.extend([
        {"type": "missing_prices", "count": len(missing_prices), "rows": missing_prices,
         "message": "Giữ giá trống; cần liên hệ báo giá, không suy ra từ cột Thành tiền."},
        {"type": "inventory_not_recorded", "count": availability_counts.get("unknown", 0),
         "message": "File không có số lượng tồn kho; cần xác nhận trước khi hoàn tất đơn hàng."},
        {"type": "duplicate_skus", "count": len(duplicates), "duplicates": duplicates,
         "message": "Giữ từng dòng sản phẩm riêng bằng ID theo dòng, không dùng SKU làm khóa duy nhất."},
        {"type": "missing_skus", "count": len(missing_skus), "rows": missing_skus},
    ])
    if missing_images:
        warnings.append({"type": "missing_images", "rows": missing_images})
    metadata = {
        "source_file": workbook.name,
        "source_sha256": hashlib.sha256(workbook.read_bytes()).hexdigest(),
        "schema_version": 1,
        "currency": "VND",
        "sheets": sheet_names,
        "product_count": len(products),
        "series_count": len({p["series"] for p in products}),
        "image_count": len(extracted_media),
        "image_association_count": len(image_associations),
        "products_with_images": len(products) - len(missing_images),
        "priced_product_count": len(products) - len(missing_prices),
        "availability_counts": availability_counts,
        "warnings": warnings,
    }
    write_json(ROOT / "data" / "catalog.json", {"metadata": metadata, "products": products})
    write_json(ROOT / "data" / "import-report.json", {**metadata, "image_associations": image_associations})
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("workbook", nargs="?", type=Path, default=ROOT / "SEntai.xlsx")
    args = parser.parse_args()
    if not args.workbook.is_file():
        parser.error(f"Workbook not found: {args.workbook}")
    report = import_catalog(args.workbook.resolve())
    print(f"Imported {report['product_count']} products, {report['image_count']} original images "
          f"({report['image_association_count']} row associations), "
          f"{report['priced_product_count']} unit prices.")
    print("Catalog: data/catalog.json | Report: data/import-report.json")


if __name__ == "__main__":
    main()
