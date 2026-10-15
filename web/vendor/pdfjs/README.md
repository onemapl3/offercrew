# PDF.js offline font resources

Unmodified `cmaps/` and `standard_fonts/` from Mozilla `pdfjs-dist@6.1.200`, matching the PDF.js build in the locked `unpdf@1.8.1`.

Source: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.1.200.tgz
Archive SHA-256: `2e46aa56491f6576ec95b9f87bcf5ae52e97e3f09652ed2181f12405c3f0d30a`

The original licenses are preserved next to each resource collection and in `LICENSE`. These resources are served only by the restricted `/vendor/pdfjs/` routes; no CDN, PDF scripting, native canvas dependency, or change to model parsing is required. When updating `unpdf`, check the embedded PDF.js version and rerun the original-PDF preview tests, including a CJK CID font and the last page.
