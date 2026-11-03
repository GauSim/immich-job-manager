Small synthetic images for the iOS screenshot tag tests (EXIF `UserComment`, 8-byte charset prefix + text):

| File | Tag |
| --- | --- |
| `ios-screenshot.png` | `ASCII` "Screenshot" in the PNG `eXIf` chunk (like iOS) |
| `ios-screenshot-unicode.png` | `UNICODE` (UTF-16) "Screenshot" |
| `jpeg-screenshot-tag.jpg` | "Screenshot" in a JPEG |
| `png-without-tag.png` | none |
| `reencoded-screenshot.jpg` | none (the screenshot re-encoded, metadata lost) |
| `photo-with-other-comment.jpg` | "Holiday" + camera make/model |

Generated with Pillow (see the phase 6 commit); random pixels, no real content.
