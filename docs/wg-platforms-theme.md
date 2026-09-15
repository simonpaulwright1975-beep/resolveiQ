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

### The illustrated landing page does not exist

Sections 1–9 describe a watercolour landing/login page — WG balloon, illustrated
product scene, floating entry card, "Press here to enter", Walter Geering
signature. **None of it is built.** ResolveIQ opens straight onto the console.

That is a separate piece of work and it was not part of the re-theme.

### `--bg-deeper` is unused

Defined, because it is part of the shared block, but ResolveIQ has nothing that
calls for it yet.
