# Instructions for Matching a SignalK Webapp to the SignalK Server UI

## Overview

This guide documents the exact approach used to make the advancedwind webapp match the SignalK admin UI look and feel. It reuses the SignalK server's own compiled CoreUI/Bootstrap stylesheet at runtime, with no external downloads and no hardcoded file paths.

---

## 1. Understand the SignalK Admin UI Stack

- **Framework:** CoreUI 2.x, a Bootstrap 4 admin template. All layout, components and utilities are Bootstrap 4 classes.
- **Build tool:** Vite. The compiled stylesheet has a **hashed filename** (e.g. `assets/style-CzSZ78W4.css`) that changes on every SignalK rebuild or update. **Never hardcode this path.**
- **Served from:** `http://localhost:3000/admin/` (the admin UI root redirects here). The plugin webapp is served from `http://localhost:3000/<pluginname>/`.
- **All assets are local.** No CDN, no internet required.

---

## 2. Dynamically Inject the SignalK Stylesheet

Because the CSS filename is hashed, discover it at runtime by fetching the admin UI root page and parsing the `<link rel="stylesheet">` tag out of it.

Add this inline `<script>` in `<head>` **before** any local stylesheet:

```html
<script>
  (async () => {
    try {
      const res  = await fetch('/');
      const html = await res.text();
      const doc  = new DOMParser().parseFromString(html, 'text/html');
      const link = doc.querySelector('link[rel="stylesheet"]');
      if (link) {
        const el = document.createElement('link');
        el.rel  = 'stylesheet';
        // Use res.url (final URL after redirects) as base — the admin UI
        // is served at /admin/, not /, so relative hrefs must resolve against it.
        el.href = new URL(link.getAttribute('href'), res.url).href;
        document.head.appendChild(el);
      }
    } catch (e) {
      console.warn('[webapp] Could not load SignalK admin stylesheet:', e);
    }
  })();
</script>

<!-- Local overrides must come AFTER the injected stylesheet -->
<link rel="stylesheet" href="main.css">
```

**Why `res.url` and not `window.location.origin`?**
`fetch('/')` follows the redirect from `/` to `/admin/`. `res.url` is the final URL after redirects, so relative paths like `./assets/style-*.css` resolve correctly to `/admin/assets/style-*.css`.

---

## 3. Body Classes

Use the exact CoreUI body classes that the SignalK admin UI uses:

```html
<body class="app header-fixed sidebar-fixed aside-menu-fixed aside-menu-hidden">
```

This activates CoreUI's fixed header and sidebar layout. The CSS handles all positioning.

---

## 4. Page Layout Structure

Follow the CoreUI 2.x layout exactly. This is the structure SignalK itself uses:

```html
<body class="app header-fixed sidebar-fixed aside-menu-fixed aside-menu-hidden">

  <header class="app-header navbar navbar-light bg-white">
    <!-- brand group: logo image + title text + sidebar toggler -->
    <div class="d-flex align-items-center">
      <a class="d-flex align-items-center gap-2 me-0 text-decoration-none" href="#">
        <img src="icon.png" alt="My Plugin" style="height:32px;width:auto;">
        <span class="app-title">My Plugin</span>
      </a>
      <button class="navbar-toggler sidebar-toggler d-md-down-none ms-2" type="button" id="sidebarToggler">
        <span class="navbar-toggler-icon"></span>
      </button>
    </div>
    <!-- error/status message floats right -->
    <span id="message" class="text-danger small ms-auto me-3"></span>
  </header>

  <div class="app-body">

    <div class="sidebar">
      <nav class="sidebar-nav">
        <ul id="my-nav" class="nav"></ul>
      </nav>
      <button class="sidebar-minimizer brand-minimizer" type="button" id="sidebarMinimizer"></button>
    </div>

    <main class="main">
      <div class="container-fluid pt-3">
        <!-- page content here -->
      </div>
    </main>

  </div>

  <script>
    document.getElementById('sidebarMinimizer').addEventListener('click', () => {
      document.body.classList.toggle('sidebar-minimized');
      document.body.classList.toggle('brand-minimized');
    });
    document.getElementById('sidebarToggler').addEventListener('click', () => {
      document.body.classList.toggle('sidebar-hidden');
    });
  </script>

</body>
```

**Key points:**
- Do **not** put `navbar-brand` on the `<a>` wrapping your logo — CoreUI injects the SignalK logo image and "Signal K" text as a background/pseudo-element on `.app-header .navbar-brand`. Use `app-title` on just the text `<span>` instead.
- The sidebar minimizer button (`sidebar-minimizer`) is purely CSS-driven. Toggling `sidebar-minimized` and `brand-minimized` on `<body>` is all that's needed — no CoreUI JS required.

---

## 5. Sidebar Navigation

Build nav items as `li.nav-item > a.nav-link` inside the `ul.nav`. This is the exact structure from the SignalK admin sidebar:

```js
function buildNav() {
  const nav = document.getElementById("my-nav");
  nav.innerHTML = "";
  steps.forEach(step => {
    const li = document.createElement("li");
    li.className = "nav-item";
    const a = document.createElement("a");
    a.className = "nav-link" + (step.id === currentStepId ? " active" : "");
    a.href = "#";
    a.textContent = step.label;
    a.onclick = (e) => { e.preventDefault(); currentStepId = step.id; renderAll(); };
    li.appendChild(a);
    nav.appendChild(li);
  });
}
```

CoreUI's compiled CSS handles all sidebar colours, hover states and the active left-border highlight. Only override what you must (e.g. a custom accent colour) in your local `main.css`.

---

## 6. Cards

Use standard Bootstrap 4 cards. For a card with a title and an enable toggle in the header:

```html
<div class="card">
  <div class="card-header">
    <div class="fw-bold text-uppercase" id="step-title">Overview</div>
    <div id="panel-enable"></div>  <!-- toggle injected here by JS -->
  </div>
  <div class="card-body">
    <!-- content -->
  </div>
</div>
```

Do **not** nest cards inside cards — it creates double borders and double padding.

For a two-column layout inside a card body (e.g. graph left, panel right):

```html
<div class="card-body">
  <div class="row">
    <div class="col-md-5 col-lg-4"><!-- graph --></div>
    <div class="col-md-7 col-lg-8"><!-- panel --></div>
  </div>
</div>
```

---

## 7. Toggle Switches (Checkboxes)

Use CoreUI's `switch-text switch-primary` pattern — this is what SignalK itself uses in plugin config pages:

```js
const lbl = document.createElement("label");
lbl.className = "switch switch-text switch-primary";
const cb = document.createElement("input");
cb.type = "checkbox";
cb.className = "switch-input form-check-input";
cb.checked = !!value;
cb.onchange = () => saveValue(cb.checked);
const switchLabel = document.createElement("span");
switchLabel.className = "switch-label";
switchLabel.setAttribute("data-on", "On");
switchLabel.setAttribute("data-off", "Off");
const switchHandle = document.createElement("span");
switchHandle.className = "switch-handle";
lbl.appendChild(cb);
lbl.appendChild(switchLabel);
lbl.appendChild(switchHandle);
```

---

## 8. Form Controls

| Control | Class |
|---|---|
| Number input | `form-control form-control-sm` + `style="width:80px"` |
| Text input | `form-control form-control-sm` |
| Select / dropdown | `form-select form-select-sm` |
| Reset button | `btn btn-link btn-sm p-0 ms-1` |

---

## 9. Data Tables (Settings, Inputs, Outputs)

Use Bootstrap table classes and `table-layout: fixed` to keep columns stable across scenes:

```js
const table = document.createElement("table");
table.className = "table table-sm table-borderless mb-0";
```

Add this to `main.css` to lock column widths:

```css
.card-body .table {
  table-layout: fixed;
  width: 100%;
}
.card-body .table td:first-child {
  width: 55%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.card-body .table td:last-child {
  width: 45%;
}
```

---

## 10. Section Headings

```js
const h = document.createElement("h6");
h.className = "text-uppercase fw-bold text-muted border-bottom pb-1 mt-3 mb-1 small";
h.textContent = text;
```

---

## 11. What to Keep in `main.css`

After the migration, `main.css` should contain **only**:

1. **CSS variables** for SVG vector colours
2. **SVG element stroke rules** (by element ID)
3. **SVG canvas rule** (`border`, `aspect-ratio`)
4. **SignalK brand suppression** — neutralise the CoreUI-injected logo/text on `.app-header .navbar-brand`:
   ```css
   .app-header .navbar-brand {
     background-image: none !important;
     width: auto !important;
   }
   .app-header .navbar-brand::before,
   .app-header .navbar-brand::after {
     display: none !important;
     content: none !important;
   }
   ```
5. **App title style** (since we don't use `.navbar-brand` on our title):
   ```css
   .app-title {
     font-size: 1.1rem;
     font-weight: 500;
     color: #29363D;
   }
   ```
6. **Sidebar accent override** (only if your accent colour differs from CoreUI default):
   ```css
   .sidebar .nav-link.active {
     border-left-color: #00bcd4 !important;
   }
   ```
7. **Enable toggle positioning** in the card header:
   ```css
   .card-header { position: relative; }
   .card-header #panel-enable {
     position: absolute;
     right: 1rem;
     top: 0;
     bottom: 0;
     display: flex;
     align-items: center;
   }
   .card-header #panel-enable > *,
   .card-header #panel-enable .switch {
     margin: 0;
   }
   ```
8. **Stable table column widths** (see Section 9)

Do **not** add layout rules for `body`, navbar, sidebar, cards or form controls — those are all owned by the CoreUI stylesheet.

---

## 12. Pitfalls and Known Issues

| Issue | Cause | Fix |
|---|---|---|
| SignalK logo / "Signal K" text appears in header | CoreUI CSS targets `.app-header .navbar-brand` with a background image | Suppress with `background-image: none !important`; do not use `navbar-brand` class on your own title element |
| CSS stylesheet 404 / doesn't load | `res.url` not used as base, or SignalK admin UI served at unexpected path | Always use `new URL(href, res.url).href` to resolve the stylesheet path |
| Enable toggle pushes card header taller | Switch widget has natural height greater than text line height | Use `position: absolute` on the toggle container so it is out of layout flow |
| Table value column jumps between scenes | Browser sizes columns from content without `table-layout: fixed` | Set `table-layout: fixed` and explicit `width` on both `td` columns |
| Sidebar not collapsing | Missing toggle JS or wrong body classes | Toggle `sidebar-minimized` + `brand-minimized` on `<body>` via JS; no CoreUI JS bundle needed |
