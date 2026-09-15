# WG Platforms theming — what was applied, and what wasn't

ResolveIQ now follows the WG Platforms design system rather than having a look
of its own. The rule from the brief: *the logo tells the user which application
they are using; the UI tells the user they are within WG Platforms.*

## Applied

| | |
|---|---|
| Palette | The `:root` block in `assets/styles.css` is pasted **verbatim** from `BRAND.md` in `simonpaulwright1975-beep/push`. A brand update is a paste, not a rewrite. |
| Aliases | ResolveIQ's own token names sit underneath, mapped by **role**. |
| Typography | Inter, loaded from Google Fonts exactly as `BRAND.md` specifies. |
| Radii | Cards 13px, buttons 10px, pills 999px. |
| Shadow | The `BRAND.md` values. |
| Favicon | `#0d5a3b`. |

### Two aliases that would be wrong if matched on name

`BRAND.md` warns that token roles are what trip people up. Two did:

- **`--accent-soft`** was a tinted *background* here (pills, selected rows,
  agent messages). BRAND's `--accent-soft` is a saturated mint for decorative
  fills. Those seven usages now take **`--accent-bg`** — matching on name would
  have given bright mint chips.
- **`--track`** is a progress-bar groove, so it takes **`--bg-soft`**, not a
  line colour.

### Monospace numerals are gone

The old visual language set every numeral in monospace. `BRAND.md` says one
face across the suite, so numbers are Inter with `tabular-nums`, which keeps
columns aligned without a second typeface.

### Dark mode was removed

This app had a full dark palette. `BRAND.md` v1 is light-only and defines no
dark values.

Keeping it would have meant inventing brand colours, and a dark theme unique to
ResolveIQ would break the one thing the brief exists to protect — that the suite
looks like one product. `color-scheme: light` is now declared so browsers do not
auto-invert form controls on a dark OS.

If dark mode is wanted, it belongs in `BRAND.md` v2 and should land across every
app at once.

## Not applied — and you should know

### The logo is a reconstruction, and the brief forbids that

Section 6 says: *"Use the supplied transparent PNG or SVG exactly as provided.
Do not redraw or reinterpret the logo."*

The logo in the masthead was **rebuilt from an image**, because no file was
supplied. It is close — Montserrat 800 outlined, matched greens — but it is a
reinterpretation, which is exactly what that section rules out.

**To fix:** drop the real file in as `assets/logo-mark.svg` (icon + wordmark,
for the masthead) and `assets/logo.svg` (full lockup with strapline). The
masthead inlines the mark directly in `index.html`, so that copy needs replacing
too. No other change is needed.

### The illustrated landing page is built — the artwork is not supplied

`landing.html` is live at **`/landing`**, built as the one reusable template the
brief asks for. See "The landing page" below.

### `--bg-deeper` is unused

Defined, because it is part of the shared block, but ResolveIQ has nothing that
calls for it yet.


---

# The landing page

**The landing page is the front door.**

| Path | Serves |
|---|---|
| `/` | The Walter Geering landing page |
| `/console` | The customer care console |
| `/console/` | 301 to `/console` |
| `/landing`, `/landing.html` | The landing page (kept, so older links still work) |

`/console/` redirects rather than serving: with a trailing slash the console's
relative asset paths resolve against `/console/`, so every stylesheet and script
would 404 and the page would render unstyled.

**Cerian should bookmark `/console`.** She is in this app all day and does not
need the front door every time; the landing exists for people arriving at the
suite, and for the Walter Geering entrance the brief describes. The server prints
both URLs on boot.

### One expected 404

Until the artwork is added, every load of the landing page logs
`404 /assets/landing-scene.png`. That is correct — the file genuinely is not
there, and the gradient fallback takes over. It disappears the moment the
artwork is dropped in. A placeholder file would silence it while hiding the
fact that the real asset is still missing.

## Copying it into another iQ app

Copy `landing.html`, `assets/landing.css`, `assets/landing.js` and the artwork.
Then edit **one block** — the only part that changes between apps:

```js
window.WG_APP = {
  APP_LOGO:      'assets/logo.svg',
  APP_NAME:      'ResolveiQ',
  APP_STRAPLINE: null,
  APP_ENTRY_TEXT:'Enter ResolveiQ',
  APP_URL:       '/'
};
```

`APP_STRAPLINE` is `null` here on purpose. The brief says not to recreate the
strapline independently when it is already part of the supplied logo — set it
only for an app whose logo does not carry one, or you get it twice at two sizes.

## The artwork

**Supplied and in place.** Two files:

| | |
|---|---|
| `assets/landing-scene.png` | The master, as supplied — 1492 × 1054, 2.0 MB. |
| `assets/landing-scene.webp` | What is actually served — **137 KB, 93% smaller**, no visible difference on a watercolour. |

2 MB on the front door is a lot for one decorative image, so the CSS points at
the WebP. If the illustration is ever revised, replace the PNG and regenerate
the WebP from it.

The server had no MIME entry for `.webp`; without one it is served as
`octet-stream` and browsers will not paint it as a background. Added, along with
`.jpg`/`.jpeg`. A test now fails if the CSS names a file that is missing from
disk or absent from the MIME map.

If the file is ever removed, a layered gradient stands in — deliberately plain,
so it reads as *artwork not loaded* rather than as an attempt at the
illustration.

**Do not reach for `image-set()` there.** It picks a candidate by *type
support*, not by whether the file exists, so listing a `.webp` that has not been
added yet silently kills the entire layer — the artwork never appears and
nothing tells you why. That cost a debugging cycle here; a test now fails if it
comes back.

## How the composition responds

| | |
|---|---|
| Desktop | `background-size: contain`, not `cover`. The artwork is wider than it is tall, so `cover` on a 16:9 screen crops the balloon off the top and the products off the bottom — the two things the page is anchored on. Any remainder is mint ground. |
| Tablet | Same, pulled up to 22% so the balloon and central products stay clear of the card. |
| Mobile | The scene stops being a backdrop and becomes a band across the top, cropped to `center top` so the balloon survives. The panel sits below it on the mint ground. Nothing is scaled down to fit — that is the brief's "crop and reposition, never squash". |

A soft white radial sits behind the panel on desktop and tablet so the card stays
legible wherever it falls on the illustration.

## Where the panel sits, and why

They did fight. The gift-box stack runs from mid-height down to the props along
the bottom, so a centred card landed squarely on the boxes.

The illustration is the locked asset, so the panel moved. It now sits **below**
the scene rather than over its middle: the artwork occupies a band across the
top and the card sits beneath it, with the card's top edge overlapping the foot
of the scene so it still reads as floating over it rather than stacked under it.

Measured rather than eyeballed — at 1440×900, 1440×760 and 834×1000 the panel's
top edge clears the bottom of the box stack and the whole card stays inside the
viewport.

Two dials at the top of `.landing` if it needs adjusting:

| | |
|---|---|
| `--scene-height` | How much viewport height the illustration gets. Lower it to give the panel more clear ground. |
| `--panel-drop` | A straight nudge downward. |

### The edges are feathered, and the mask has a trap in it

The illustration carries its own white background, so against the mint ground
its edges read as a pasted-in rectangle. A radial mask fades them.

**The mask only works because `.scene` is sized to the artwork's aspect ratio.**
Mask percentages resolve against the element, so the first attempt — a
viewport-wide band — put the entire fade out in the empty margins either side of
the picture and left its edges exactly as hard as before. The element is now
`width: min(calc(var(--scene-height) * 1492 / 1054), 100vw)`, which is the
artwork's own box. **If the artwork's aspect ratio changes, that ratio must
change with it** or the feathering silently stops working.
