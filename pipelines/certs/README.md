# Pipeline TLS intermediate CAs

Grid-India (`webapi.grid-india.in`, `webcdn.grid-india.in`) serves **leaf-only TLS chains** — the intermediate CA is missing
from the handshake. Node's bundled roots cannot complete verification without the
intermediate in `extra-cas.pem`.

| Intermediate | Hosts | Expires |
|--------------|-------|---------|
| Go Daddy Secure Certificate Authority - G2 | Grid-India CDN/API | 2031-05-03 |

`pipelines/lib.ts` loads this bundle programmatically (system CAs + this PEM).
The npm scripts and CI workflow also set `NODE_EXTRA_CA_CERTS` as a belt-and-braces
fallback. The PEM file must contain **certificates only** — no `#` comment lines
(Linux OpenSSL rejects them in `NODE_EXTRA_CA_CERTS`).
