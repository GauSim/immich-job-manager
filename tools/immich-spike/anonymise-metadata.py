#!/usr/bin/env python3
"""Turn a spike report into an anonymised metadata fixture for scorer tests.

Usage: python3 anonymise-metadata.py <spike-report.json> <out.json>

Keeps only what the screenshot scorer looks at: file name *pattern*, MIME type,
dimensions, camera EXIF fields and the description (only "" / "Screenshot").
Drops ids, dates, GPS, places, file sizes. Digits and UUIDs in file names are
replaced with random ones (seeded, so reruns are stable).
"""
import json
import random
import re
import sys
import uuid

KEEP_DESCRIPTIONS = {"", "Screenshot"}
UUID_RE = re.compile(r"[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}")


def main(src: str, dst: str) -> None:
    rnd = random.Random(42)
    report = json.load(open(src))
    by_name = report["search.metadata.page1"]["result"]["exifByName"]
    out = []
    for i, (name, v) in enumerate(sorted(by_name.items(), key=lambda kv: rnd.random())):
        e = v.get("exif") or {}

        def new_uuid(m: re.Match) -> str:
            u = str(uuid.UUID(int=rnd.getrandbits(128), version=4))
            return u.upper() if m.group(0).isupper() else u

        anon = UUID_RE.sub(new_uuid, name)
        anon = re.sub(r"\d", lambda _: str(rnd.randrange(10)), anon)
        description = e.get("description") or ""
        camera = any(e.get(k) not in (None, "") for k in ("make", "model", "lensModel", "exposureTime", "fNumber"))
        out.append(
            {
                "id": f"fx-{i:04d}",
                "type": "IMAGE",
                "originalFileName": anon,
                "originalMimeType": v["mime"],
                "width": v["w"],
                "height": v["h"],
                "exifInfo": {
                    "make": e.get("make"),
                    "model": e.get("model"),
                    "lensModel": e.get("lensModel"),
                    "exposureTime": e.get("exposureTime"),
                    "fNumber": e.get("fNumber"),
                    "exifImageWidth": e.get("exifImageWidth"),
                    "exifImageHeight": e.get("exifImageHeight"),
                    "description": description if description in KEEP_DESCRIPTIONS else "(camera note)",
                },
                # Ground truth where known: iOS marks screenshots; camera EXIF means a photo.
                "label": "screenshot" if description == "Screenshot" else "photo" if camera else "unknown",
            }
        )
    with open(dst, "w") as f:  # one asset per line: compact and diff-friendly
        f.write("[\n" + ",\n".join(json.dumps(a, ensure_ascii=False) for a in out) + "\n]\n")
    print(f"wrote {len(out)} assets to {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
