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

## Deploy

Every push to `main` builds the app and publishes it to GitHub Pages
(`.github/workflows/deploy.yml`) at https://anthemik.github.io/drawdoll/. On iPad, open that in
Safari and choose Share → Add to Home Screen; it then runs full screen and works offline.

## Using it

- **Pose:** tap a body part, then use its sliders. Shoulders and hips have a direction pad: drag the dot
  to aim the limb (centre = hanging down, rim = straight up); the shaded area is the joint's real range.
  The collarbone follows the arm automatically.
- **Drag to pose:** dots on the doll can be dragged directly:
  - **Wrists and ankles (blue):** place a hand or foot; the limb follows within its joint limits.
  - **Elbows and knees (light blue):** swing the upper arm or thigh (a lifted knee bends like a
    march step). If the hand/foot is pinned, they steer which way the elbow/knee points instead.
  - **Hips, chest, head (green):** move the hips to crouch, lunge or sit (feet on the floor stay
    planted); bend the spine (free arms keep hanging); nod and tilt the head.
  In a hand or foot panel you can pin it in place and set which way the elbow or knee points.
  The head panel has **Look at camera**.
- **Floor:** with *Keep feet on the floor* on, nothing sinks through it. A foot brought near the
  floor lands flat; a planted foot rolls onto its ball when the ankle runs out of flex; lowering
  the hips all the way gives a seated or kneeling pose; free hands rest on the floor rather than
  propping the body up.
- **Body:** choose **Mannequin** (simple forms) or **Realistic** (a detailed human body), then
  age 2 → adult, sex (female ↔ neutral ↔ male), height, build, muscle. Both bodies share the
  same skeleton, so poses, presets and dragging work identically.
- **Camera:** lens in mm (35 mm equivalent), preset views, canvas size. The bright frame in the
  viewport is exactly what exports.
- **Look:** shaded / toon / line art, outlines, face guide lines, light direction.
- **Export PNG:** transparent, white or gray background; optional floor shadow, grid and horizon line.

## Realistic body asset

`public/realistic/body.{json,bin}` is generated from MakeHuman's CC0 base mesh, skin weights and
macro shape targets by `tools/build_realistic.py` (no Blender needed). To regenerate, download
`makehuman/data/3dobjs/base.obj`, `rigs/default.mhskel`, `rigs/default_weights.mhw` and the
`targets/macrodetails/*.target` files (baby/child/young) from
https://github.com/makehumancommunity/makehuman into a folder laid out the same way, then:

```bash
python3 -I tools/build_realistic.py path/to/that/folder public/realistic
```

## Code map

| File | What it does |
|---|---|
| `src/proportions.ts` | Age/sex/build → every body dimension (growth-chart heights, heads-tall table) |
| `src/figure.ts` | Builds the skeleton and mannequin meshes, materials, outlines, balance model |
| `src/loft.ts` | Sweeps cross-sections into smooth body-part meshes |
| `src/joints.ts` | Pose controls, joint ranges, ball-joint reach maps, applying a pose to the bones |
| `src/ik.ts` | Two-bone IK for arms and legs, pins, elbow/knee direction, look-at |
| `src/realistic.ts` | Loads the realistic body, blends its shape targets, fits the skeleton to it |
| `tools/build_realistic.py` | Converts MakeHuman assets into the realistic body asset |
| `src/pad.ts` | The direction pad for shoulders and hips |
| `src/viewer.ts` | Scene, camera/lens maths, export frame, lights, picking |
| `src/export.ts` | Full-resolution PNG render |
| `src/app.ts` | State, undo/redo, persistence and the side panel UI |
