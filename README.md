# PassIt

**AirDrop for browser state.** You are reading something on your laptop. Press
one key, scan the code with your phone, and the phone opens the same page — at
the same paragraph, with the same text highlighted. Scan it again on another
computer and carry on there.

Not a bookmark. A bookmark saves an address; PassIt moves a *reading position*.

```
┌──────────────────┐        ┌─────────┐        ┌──────────────────┐
│  laptop          │        │  phone  │        │  other computer  │
│  ⌥⇧P  →  ▓▓ QR   │ ─scan→ │  opens  │ ─show→ │  webcam scan     │
│                  │        │  the QR │        │  carries on      │
└──────────────────┘        └─────────┘        └──────────────────┘
```

---

## How it works

The whole handoff is **inside the link**. There is no server, no account and no
sync: the payload rides in the URL fragment, which browsers never send over the
network. A handoff is as private as the two screens involved, and it works on a
plane with the wifi off.

```
https://your-passit-page/#PQE647TLOJ2XG5DJNZSXIZLS…
└──────────┬───────────┘ └──────────────┬─────────┘
   a static page that            deflate + base32 of
   never sees the payload        {url, title, selection,
                                  text anchor, scroll, media}
```

### Restoring your place on a page you don't control

This is the hard part. You cannot inject a scroll script into a third-party
site from a phone, so PassIt uses a platform feature instead:
[text fragments](https://wicg.github.io/scroll-to-text-fragment/). The sender
records a distinctive snippet of the text that was actually on screen, and the
link becomes:

```
https://example.com/article#section-4:~:text=The%20surface%20code%20needs,logical%20one.
                            └───┬───┘ └────────────────┬──────────────────┘
                     element id fallback      the browser scrolls here
                                              and highlights the passage
```

Supported by Chrome, Edge, Safari 16.1+ and Firefox 131+. Three details make
the difference between this working and *almost* working:

- **The reader's paragraph, not the page's furniture.** Capture probes the
  viewport with `elementFromPoint` and skips anything `fixed` or `sticky`, so a
  cookie banner or a floating nav bar never becomes the anchor.
- **Uniqueness.** A text fragment scrolls to the *first* match, so a snippet
  that also appears higher up would send the reader backwards. PassIt lengthens
  the snippet until it is unique, and failing that pins it with a `prefix-`
  drawn from the preceding text, grown until the pair is unambiguous.
- **Graceful degradation.** The nearest stable element id is kept in front of
  the directive, so a browser that ignores `:~:` still lands nearby.

If a selection existed, that wins — it is the strongest statement of what the
sender meant. If the page has no usable text at all, the receiver shows "was
63% down" rather than pretending.

### Why the QR is smaller than you'd expect

The payload is base32, not base64. RFC 4648's alphabet is a subset of the QR
*alphanumeric* charset, which costs 5.5 bits per character instead of 8 — and
the encoder emits a byte segment for the URL prefix followed by an alphanumeric
segment for the payload. That is about 18% more data in the same symbol, which
is the difference between a code that scans from across a desk and one that
doesn't. A typical handoff lands around QR version 12–15.

---

## Running it

```sh
npm start        # build, then serve dist/web on every interface
```

It prints a LAN address and a QR of it, because typing an IP into a phone is
exactly the friction PassIt exists to remove:

```
  this machine   http://localhost:8787/
  other devices  http://192.168.1.24:8787/
```

`dist/web` is four static files. Host them anywhere — GitHub Pages, S3, a
Raspberry Pi — and point the sender at that origin. The page is only a decoder;
it never receives the payload.

### The sending side

**Extension** (Chrome, Edge, Arc, Brave):

1. `chrome://extensions` → Developer mode → Load unpacked → `dist/extension`
2. Open its settings (⚙ in the popup) and set the receiver to wherever you
   hosted `dist/web`
3. Press <kbd>⌥⇧P</kbd> on any tab

It asks for `activeTab`, `scripting` and `storage` — no host permissions, so it
cannot read anything until you press the button.

**Bookmarklet** (works in Safari, works on a machine you can't install things
on): open the receiver page, expand *Set up the sending side*, and drag the
button to your bookmarks bar. Clicking it overlays the code on whatever page
you're on.

---

## Layout

```
shared/          the parts every surface needs
  qr.js          QR encoder: versions 1–40, mixed byte/alphanumeric segments
  codec.js       state ⇄ link (deflate, base32, key packing)
  target.js      text fragments, media timestamps, the URL to actually open
  capture.js     what "where I am on this page" means, measured in the page
  bookmarklet-ui.js  the overlay, in a shadow root
web/             the receiver page
extension/       MV3 popup and options
tools/           PNG writer, WKWebView test driver, Vision QR decoder
build.js         copies shared/, generates injected.js + the bookmarklet + icons
serve.js         static server that tells you its LAN address
```

No dependencies, anywhere. `build.js` is not a bundler: the browser targets all
speak ES modules, so it only has to produce the two artefacts that genuinely
cannot be modules — the script the extension injects, and the bookmarklet —
which it does by concatenating `shared/` and stripping the import/export
syntax, then compiling the result to catch name collisions before they ship.

---

## Tests

```sh
npm test
```

61 tests, no test framework. Two of them are worth calling out because they
check things that self-consistency cannot:

- **QR symbols are decoded by Apple's Vision framework** (`tools/decode-qr.swift`).
  A wrong error-correction table or a bad mask produces a symbol that round-trips
  perfectly through your own decoder and scans on no real phone. All 40 versions
  were verified this way.
- **Capture and restore run in real WebKit** (`tools/run-page.swift` drives a
  `WKWebView`). The tests scroll a fixture article, capture, then *load the
  resulting link back* and assert that the paragraph which was on screen is on
  screen again — including the case where that paragraph appears twice in the
  document.

WebKit rather than headless Chrome partly because it is the engine most
receiving phones run, and partly because it needs no listening socket, which
makes the suite work on locked-down machines.

---

## Deliberate omissions

- **No relay server.** Everything fits in the QR, and adding a server would
  mean a URL and a scroll position leaving the room. If a page's URL is so long
  that the payload doesn't fit, the sender says so rather than silently
  truncating.
- **No auto-navigation.** The receiver always waits for a tap and always shows
  the destination host first. A QR code can say anything, and a scheme that
  isn't `http(s)` is refused outright — rendered as a link on the receiver's
  own origin, a `javascript:` URL would execute there.
- **No history.** Pressing back returns to the handoff card with its link
  intact, which is all the persistence this needs. It is not a bookmark
  manager.

## Known limits

- Pages that render their content after load (single-page apps, infinite
  scroll) can lose the text fragment: the browser matches against the document
  as it first renders. The element-id fallback usually still fires.
- Only YouTube has a timestamp format PassIt knows how to write. Anywhere else
  the video position is shown on the card but not seeked to.
- Extensions cannot read `chrome://` pages, the Web Store or the built-in PDF
  viewer; there the popup passes the address alone and says so.
