# Notice: the web tools

The web tools in `src/extensions/web/` are a port of [`@ian-pascoe/pi-web-tools`](https://github.com/ian-pascoe/pi-extensions/tree/main/packages/pi-web-tools)
(version 0.6.7, commit `c126370`), the owner's own package, released under the MIT licence:

> MIT License
>
> Copyright 2026 Ian Pascoe
>
> Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
> documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
> rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
> persons to whom the Software is furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
> Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
> WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
> COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
> OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

Changed from pi-web-tools: `json-reindent.ts` and `html-main-content.ts` are unchanged; `content.ts` and `html-text.ts` are moved out of `web-fetch.ts`; `html-markdown.ts` is rewritten as one linear pass over htmlparser2 events (Turndown needs a DOM and is quadratic); `output.ts` has no temp-file spill (continuation notes name the next `offset`); `net.ts` is the SSRF guard and bounded network reads as plain Promise code; `fetch.ts` is `web_fetch` as a plain pi-durable tool; `search.ts` asks a search-capable model on one of the owner's Model endpoints instead of Exa or Parallel (no new key).
