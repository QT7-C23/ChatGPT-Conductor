# Third-party notices

ChatGPT Conductor is licensed under [MIT](LICENSE). The runtime includes the following locked dependencies, whose original license files are retained without modification.

| Package | Version | License | Copyright | Runtime license path |
|---|---|---|---|---|
| yauzl | 3.4.0 | MIT | 2014 Josh Wolfe | `node_modules/yauzl/LICENSE` |
| yazl | 3.3.1 | MIT | 2014 Josh Wolfe | `node_modules/yazl/LICENSE` |
| pend | 1.2.0 | MIT (Expat) | 2014 Andrew Kelley | `node_modules/pend/LICENSE` |
| buffer-crc32 | 1.0.0 | MIT | 2013–2024 Brian J. Brennan | `node_modules/buffer-crc32/LICENSE` |

The source archive excludes installed dependencies; their exact versions, package integrity values and license declarations are recorded in `package-lock.json`. Runtime dependency file digests are recorded in `scripts/distribution/runtime-files.json`. GitHub Actions run on CI and are not bundled in the runtime as third-party action implementations.
