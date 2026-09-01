# Droidwright — Android Vector Icon Editor

A fast, lightweight, local-first vector editor built specifically for creating Android `VectorDrawable` XML icons on a real dp canvas.

---
### Try Droidwright right now: [Droidwright](https://monomixs.github.io/Droidwright/Droidwright.html)
---

## Why Droidwright?

If you've ever exported an SVG from Figma or Illustrator, imported it into Android Studio, and ended up with broken transforms, unsupported clipping masks, or messy coordinate bloat, Droidwright is for you.

Droidwright is built from the ground up around Android's vector format. You design directly on a real dp grid (like 24×24 dp), tweak shapes and points with visual canvas handles, and get clean, compliant `<vector>` XML in real time — ready to copy and paste straight into your project's `res/drawable/` folder.

Everything runs 100% locally in your browser. No accounts, no servers, no telemetry, and no build steps.

---

## Core Features

### ✏️ Drawing Tools
- **Select & Transform (`V`)**: Move, scale, and rotate shapes around a customizable pivot. Nudge precisely with arrow keys (with <kbd>Shift</kbd> for 5dp and <kbd>Alt</kbd> for 0.1dp micro-nudges).
- **Line Tool (`L`)**: 2-point line creation. Click the start point, move your mouse with a live dashed preview, and click to set the end point (or click-and-drag). Hold <kbd>Shift</kbd> to lock angles to 45° increments.
- **Bézier Curve Tool (`C`)**: Click two endpoints, then adjust the curvature directly on canvas with dedicated diamond control-point handles and tangent guides.
- **Arc & Sector Tool (`A`)**: Click two points to define the diameter, then use on-canvas handles to adjust the start angle, sweep opening, full circle, or pull the inner handle to make a donut ring.
- **Rectangles (`R`) & Ellipses (`O`)**: Quick geometric primitives with independent per-corner radius controls for rectangles.
- **Polygons & Stars (`P`)**: Configurable n-sided polygons and stars with adjustable point counts and inner radius ratios.
- **Freehand Pen (`F`)**: Point-by-point path builder for custom vector silhouettes.
- **Cut / Knife Tool (`K`)**: Trace a cutting loop over existing artwork to slice pieces out seamlessly using boolean clipping.
- **Node & Vertex Editor (`N`)**: Edit subpath anchor points, adjust curve tangents, toggle corner vs. smooth points, and add or delete anchors (<kbd>Alt</kbd> + click to delete).
- **Shape Presets (`S`)**: Instant library of common Android shapes and icons (Android bugdroid, arrows, checkmarks, hearts, stars, badges, speech bubbles, shields, gears, etc.).

### ⚡ Path & Boolean Operations
- **Boolean Engine**: Combine or carve shapes with **Union**, **Subtract**, **Intersect**, and **Exclude (XOR)**.
- **Connect / Join Lines**: Select multiple separate line segments and merge them into one continuous connected path.
- **Disconnect / Split Lines**: Explode any multi-segment path back into individual line entities.
- **Outline Stroke**: Convert strokes into filled closed paths.
- **Flatten Transforms**: Bake rotation, flips, and scale transforms directly into path coordinates.

---

## Handy Built-in Features & Quality-of-Life Tools

These are built-in features that make designing Android icons much smoother:

- **Live VectorDrawable XML Code View**: A syntax-highlighted code editor panel that generates clean Android XML on the fly. You can copy the XML with one click or download the `.xml` file.
- **Reference Image Backdrop & Eyedropper**: Drop a reference image (PNG, JPG, or SVG) onto the canvas, adjust its opacity, pan, scale, or rotate it to trace over it, and use the built-in eyedropper to pick colors directly from your reference art.
- **Material Design Keyline Guides**: Toggleable Material icon keyline circles, squares, diagonal guides, and center lines to ensure visual weight and alignment match Android design standards.
- **Magnetic Endpoint Snapping**: When moving lines or drawing curves, endpoints automatically snap to adjacent shape vertices so paths connect seamlessly without gaps.
- **Dynamic Smart Alignment Guides**: Automatic snapping and visual guide lines when objects align to each other's edges or centers.
- **SVG Drag-and-Drop Import**: Drag any `.svg` file directly onto the canvas to parse and convert it into editable Droidwright vector shapes.
- **Local Project Storage & Backup**: Automatically saves your active project to browser local storage so you never lose work on reload. You can also save multiple projects or export/import `.droidwright` JSON project files.
- **Android Attribute Customization**: Full control over `android:fillColor`, `android:fillAlpha`, `android:fillType` (`nonZero` / `evenOdd`), `android:strokeLineCap`, `android:strokeLineJoin`, `android:strokeMiterLimit`, document tint, and `android:autoMirrored="true"`.
- **Customizable Workspace**: Collapsible sidebars, layer tree with grouping and lock/hide toggles, focus mode, and zoom-to-fit (<kbd>Shift</kbd> + <kbd>1</kbd>).

---

## Keyboard Shortcuts

| Key | Tool / Action |
| :--- | :--- |
| <kbd>V</kbd> | Select Tool |
| <kbd>L</kbd> | Line Tool |
| <kbd>C</kbd> | Bézier Curve Tool |
| <kbd>A</kbd> | Arc / Sector Tool |
| <kbd>R</kbd> | Rectangle Tool |
| <kbd>O</kbd> | Ellipse Tool |
| <kbd>P</kbd> | Polygon / Star Tool |
| <kbd>F</kbd> | Pen Tool |
| <kbd>K</kbd> | Cut Tool |
| <kbd>N</kbd> | Node / Point Edit Tool |
| <kbd>S</kbd> | Shape Presets |
| <kbd>Space</kbd> + Drag | Pan Canvas |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom In / Zoom Out |
| <kbd>Shift</kbd> + <kbd>1</kbd> | Zoom to Fit |
| <kbd>Shift</kbd> (while drawing) | 45° angle constraint / 1:1 aspect ratio |
| <kbd>Ctrl</kbd> + <kbd>Z</kbd> | Undo |
| <kbd>Ctrl</kbd> + <kbd>Y</kbd> | Redo |
| <kbd>Ctrl</kbd> + <kbd>D</kbd> | Duplicate selection |
| <kbd>Ctrl</kbd> + <kbd>G</kbd> | Group selection (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>G</kbd> to ungroup) |
| <kbd>Ctrl</kbd> + <kbd>A</kbd> | Select All |
| <kbd>Delete</kbd> / <kbd>Backspace</kbd> | Delete selection or active node |
| <kbd>Escape</kbd> | Cancel current draft / clear selection |
| <kbd>Arrow Keys</kbd> | Nudge (hold <kbd>Shift</kbd> for 5dp, <kbd>Alt</kbd> for 0.1dp) |

---

## How to Run It

Droidwright is completely self-contained with zero external dependencies.

1. **Directly in Browser**: Open `index (1).html` (or `Droidwright.html`) in Chrome, Edge, Firefox, or Safari.
2. **Via Local Server** (optional):
   ```bash
   # Python
   python -m http.server 8080

   # Node.js
   npx serve .
   ```
   Open `http://localhost:8080` in your browser.

---

## Using Exported XML in Android Studio

1. Click **Export .xml** (or copy from the code panel).
2. Save the file to your Android project: `app/src/main/res/drawable/ic_my_icon.xml`.
3. Use it in Jetpack Compose:
   ```kotlin
   Icon(
       painter = painterResource(id = R.drawable.ic_my_icon),
       contentDescription = "My Icon",
       tint = MaterialTheme.colorScheme.primary
   )
   ```
   Or in classic XML layouts:
   ```xml
   <ImageView
       android:layout_width="24dp"
       android:layout_height="24dp"
       app:srcCompat="@drawable/ic_my_icon" />
   ```

---

## License

GNU General Public License v3.0
