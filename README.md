# DrawDoll

A posable 3D drawing mannequin that exports PNGs to use as an underlay layer in Procreate, Pixquare, etc.
Built with three.js + TypeScript + Vite; runs in any modern browser, including iPad Safari.

## Run

```bash
npm install
npm run dev
```

Open http://localhost:5173 on this Mac. To use it on an iPad on the same Wi-Fi, open
`http://<this Mac's IP>:5173` in Safari. Over plain http the export sheet offers **Download** and
drag-and-drop of the preview; **Share** and **Copy** appear when the app is served over HTTPS.

## Using it

- **Pose:** tap a body part, then use its sliders. Shoulders and hips have a direction pad: drag the dot
  to aim the limb (centre = hanging down, rim = straight up); the shaded area is the joint's real range.
  The collarbone follows the arm automatically.
- **Body:** age 2 → adult, sex (female ↔ neutral ↔ male), height, build, muscle.
- **Camera:** lens in mm (35 mm equivalent), preset views, canvas size. The bright frame in the
  viewport is exactly what exports.
- **Look:** shaded / toon / line art, outlines, face guide lines, light direction.
- **Export PNG:** transparent, white or gray background; optional floor shadow, grid and horizon line.

## Code map

| File | What it does |
|---|---|
| `src/proportions.ts` | Age/sex/build → every body dimension (growth-chart heights, heads-tall table) |
| `src/figure.ts` | Builds the skeleton and mannequin meshes, materials, outlines, balance model |
| `src/loft.ts` | Sweeps cross-sections into smooth body-part meshes |
| `src/joints.ts` | Pose controls, joint ranges, ball-joint reach maps, applying a pose to the bones |
| `src/pad.ts` | The direction pad for shoulders and hips |
| `src/viewer.ts` | Scene, camera/lens maths, export frame, lights, picking |
| `src/export.ts` | Full-resolution PNG render |
| `src/app.ts` | State, undo/redo, persistence and the side panel UI |
